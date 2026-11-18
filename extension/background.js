import { deriveKey, protect, seal, unseal } from "./crypto.js";
import { interactWithSite, watchSwitch } from "./site.js";

const browserAPI = globalThis.browser ?? globalThis.chrome;
const local = browserAPI.storage.local;
const memory = browserAPI.storage.session; // Trusted extension contexts only, cleared on browser restart.
const idle = 10 * 60_000;
const lifetime = 120_000;
const reviewLifetime = 5 * 60_000;
const extension = browserAPI.runtime.getURL("");
let queue = Promise.resolve();
function serialized(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch(() => {});
const originOf = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
};
async function lock() {
  await memory.clear();
  await browserAPI.action.setBadgeText({ text: "" });
  for (const tab of await browserAPI.tabs.query({}))
    await browserAPI.action
      .setBadgeText({ tabId: tab.id, text: "" })
      .catch(() => {});
}
function offerKey(id) {
  return "offer:" + id;
}
// A tab owns the notification. The review resolves the offer independently.
function offerForTab(state, tab) {
  const notice = state["draft:" + tab];
  return notice ? state[offerKey(notice.id)] : null;
}
async function detachOffer(tab) {
  await memory.remove("draft:" + tab);
  await browserAPI.action
    .setBadgeText({ tabId: tab, text: "" })
    .catch(() => {});
}
async function discardOffer(state, offer) {
  await memory.remove(offerKey(offer.id));
  if (offerForTab(state, offer.tab)?.id === offer.id)
    await detachOffer(offer.tab);
}
async function clean() {
  const s = await memory.get(null);
  if (s.key && s.deadline <= Date.now()) {
    await lock();
    return {};
  }
  for (const [k, v] of Object.entries(s)) {
    if (v?.expires <= Date.now()) {
      if (k.startsWith("offer:")) await discardOffer(s, v);
      else await memory.remove(k);
      delete s[k];
    }
  }
  return s;
}
async function touch(key) {
  const deadline = Date.now() + idle;
  await memory.set(key ? { deadline, key } : { deadline });
  await browserAPI.alarms.create("lock", { when: deadline });
}
async function setProtection(entries, password) {
  const { record, key } = await protect(entries, password);
  // Invalidate the old session before replacing the vault. If interrupted, a
  // master-password vault can always be reopened with its current password.
  await lock();
  await local.set({ vault: record });
  if (key) await touch(key);
}
function publicEntry({ password, ...rest }) {
  return { ...rest, hasPassword: !!password };
}
async function promptsDisabled() {
  return (await local.get("disabledSaveSites")).disabledSaveSites || [];
}
async function execute(tabId, func, args = []) {
  const [injection] = await browserAPI.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args,
  });
  return injection?.result ?? {};
}
async function startProvider(job, entry, site) {
  const key = "job:" + job.origin;
  const provider = entry.provider;
  // Persist before clicking. Redirects and newly opened tabs can arrive immediately.
  job.handoff = crypto.randomUUID();
  job.provider = provider;
  job.filled = true;
  job.message = site.embeddedProvider
    ? "Click the embedded Google sign-in button to continue."
    : site.ambiguousProvider
      ? "Choose the " + provider + " sign-in button on the website."
      : "Starting " +
        provider +
        " sign-in. If it stays closed, click the website’s " +
        provider +
        " button.";
  await memory.set({ [key]: job });
  await expireAt(job.expires);
  if (site.providerButton) {
    const result = await execute(job.tab, interactWithSite, [
      job.origin,
      { action: "startProvider", provider, documentToken: site.documentToken },
    ]).catch(() => null); // A redirect can destroy the executing document.
    if (result && !result.started) {
      delete job.handoff;
      job.message = "The sign-in page changed. Select the account again.";
      await memory.set({ [key]: job });
    }
  }
  await browserAPI.tabs
    .sendMessage(job.tab, { type: "refreshCapture" }, { frameId: 0 })
    .catch(() => {});
  return false;
}
async function advance(job, entries) {
  const key = "job:" + job.origin;
  const original = JSON.stringify(job);
  const tab = await browserAPI.tabs.get(job.tab);
  if (
    tab.incognito ||
    originOf(tab.url) !== job.origin ||
    !entries.some((e) => e.id === job.id)
  ) {
    await memory.remove(key);
    return false;
  }
  const entry = entries.find((e) => e.id === job.id);
  const provider = entry.method === "Provider" ? entry.provider : "";
  const site = await execute(job.tab, interactWithSite, [
    job.origin,
    {
      provider,
      openedLogin: job.openedLogin,
      openMenu: !job.opened && !job.logout && !job.filled,
    },
  ]);
  if (site.opened) job.opened = true;
  if (
    site.signedIn &&
    site.email?.toLowerCase() === entry.username.toLowerCase()
  ) {
    await memory.remove(key);
    await memory.set({ ["last:" + job.origin]: entry.id });
    job.message = "Already signed in to " + entry.label + ".";
    return false;
  }
  const delegated = ["Provider", "Passkey"].includes(entry.method);
  const loginPage = site.login || (delegated && site.providerLogin);
  if (site.signedIn && !job.logout && !job.filled) {
    job.logout = await execute(job.tab, interactWithSite, [
      job.origin,
      { action: "logout", documentToken: site.documentToken },
    ]).then((result) => !!result.logout);
    job.message = "Signing out of the current account…";
  } else if (
    provider &&
    (site.providerButton || site.embeddedProvider || site.ambiguousProvider)
  ) {
    return startProvider(job, entry, site);
  } else if (site.loginButton && !job.openedLogin) {
    const result = await execute(job.tab, interactWithSite, [
      job.origin,
      { action: "openLogin", provider, documentToken: site.documentToken },
    ]);
    job.openedLogin = !!result.opened;
    job.message = "Opening the website’s sign-in options…";
  } else if (!loginPage && !job.filled) {
    if (site.verification) {
      job.message = "Complete verification on the website to continue.";
    } else if (job.stage === "password") {
      job.message = "Waiting for the password step.";
    } else if (
      site.loginUrl &&
      !job.redirected &&
      originOf(site.loginUrl) === job.origin
    ) {
      job.redirected = true;
      await browserAPI.tabs.update(job.tab, { url: site.loginUrl });
      job.message = "Opening the sign-in page…";
    } else {
      job.message = job.logout
        ? "Waiting for the website’s sign-in page…"
        : "Open the account menu or sign out, then go to the sign-in form.";
    }
  } else if (!job.filled && loginPage) {
    if (entry.method === "Provider") {
      job.message =
        "Waiting for the website’s " + provider + " sign-in button.";
    } else if (delegated) {
      job.message =
        "Choose " +
        entry.username +
        " using " +
        (entry.provider || entry.method.toLowerCase()) +
        " sign-in.";
      job.filled = true;
    } else {
      const { stage, submitted, wrongAccount } = await execute(
        job.tab,
        interactWithSite,
        [
          job.origin,
          {
            action: "fill",
            documentToken: site.documentToken,
            entry: { username: entry.username, password: entry.password },
            stage: job.stage || "username",
            usernameSubmitted: !!job.usernameSubmitted,
          },
        ],
      );
      if (wrongAccount) {
        job.message =
          "Open a sign-in form for " +
          entry.username +
          " and select the account again.";
        job.filled = true;
      } else if (stage) {
        job.stage = stage;
        if (stage === "password") job.usernameSubmitted = submitted;
        job.message =
          stage === "password"
            ? submitted
              ? "Username submitted. Waiting for the password step."
              : "Continue on the website to reach the password step."
            : submitted
              ? "Sign-in submitted. Complete any verification on the website."
              : "Login filled. Review and submit on the website.";
        job.filled = stage === "done";
        await memory.set({ ["last:" + job.origin]: entry.id });
      }
    }
  }
  if (JSON.stringify(job) !== original) await memory.set({ [key]: job });
  return !job.filled;
}
const methods = ["Password", "Email", "Provider", "Passkey"];
function providerName(method, name) {
  return method === "Provider"
    ? String(name || "")
        .trim()
        .slice(0, 60)
    : "";
}
function matchingLogin(entries, login) {
  return entries.find(
    (e) =>
      e.origin === login.origin &&
      e.username === login.username &&
      e.method === login.method &&
      providerName(e.method, e.provider).toLowerCase() ===
        providerName(login.method, login.provider).toLowerCase(),
  );
}
async function expireAt(expires) {
  await browserAPI.alarms.create("expire", {
    when: Math.min(
      expires,
      (await browserAPI.alarms.get("expire"))?.scheduledTime || expires,
    ),
  });
}
// Only a chooser on the selected identity service can receive an account hint.
const identityHosts = new Map([
  ["google", ["https://accounts.google.com"]],
  [
    "microsoft",
    ["https://login.microsoftonline.com", "https://login.live.com"],
  ],
]);
function providerJob(state, tabId) {
  return Object.entries(state).find(
    ([name, job]) =>
      name.startsWith("job:") &&
      job.handoff &&
      (job.tab === tabId || job.popup === tabId),
  )?.[1];
}
async function providerMessage(job, m, sender, record, key) {
  if (!job || !key) return false;
  const origin = originOf(sender.url);
  const storageKey = "job:" + job.origin;
  const entry = (await unseal(record, key)).find(
    (e) =>
      e.id === job.id &&
      e.origin === job.origin &&
      e.method === "Provider" &&
      e.provider === job.provider,
  );
  if (!entry) return false;
  if (m.type === "providerReturned") {
    if (
      sender.tab.id !== job.tab ||
      origin !== job.origin ||
      m.handoff !== job.handoff
    )
      return false;
    const verified =
      typeof m.username === "string" &&
      m.username.toLowerCase() === entry.username.toLowerCase();
    job.message = verified
      ? "Signed in as " + entry.username + "."
      : m.username
        ? "The website signed in a different account. Check its account menu."
        : "The website is signed in. Check its account menu to confirm which account.";
    delete job.handoff;
    await memory.set({
      [storageKey]: job,
      ...(verified ? { ["last:" + origin]: entry.id } : {}),
    });
    return true;
  }
  if (
    (job.identityTab !== undefined && job.identityTab !== sender.tab.id) ||
    job.picked ||
    job.chooserCancelled ||
    !identityHosts.get(job.provider.toLowerCase())?.includes(origin)
  )
    return false;
  if (m.type === "providerIdentity") {
    if (job.identityTab === undefined) {
      job.identityTab = sender.tab.id;
      await memory.set({ [storageKey]: job });
    }
    return {
      username: entry.username,
      handoff: job.handoff,
      expires: job.expires,
    };
  }
  if (m.handoff !== job.handoff) return false;
  job.picked = true;
  job.message =
    "Continuing " + job.provider + " sign-in for " + entry.username + ".";
  await memory.set({ [storageKey]: job });
  return true;
}
async function draftFor(sender, m, s, record, key) {
  const origin = originOf(sender.url);
  const tab = sender.tab.id;
  const attemptKey = "attempt:" + tab;
  const attempt = s[attemptKey];
  const parentAttempt = s["attempt:" + sender.tab.openerTabId];
  if (!key || !origin || (await promptsDisabled()).includes(origin))
    return false;
  if (
    [attempt, parentAttempt].some(
      (a) => a && a.origin !== origin && a.method === "Provider",
    )
  )
    return false; // The identity provider handles its own credentials.

  const draftKey = "draft:" + tab;
  const pending = offerForTab(s, tab);
  if (m.type === "canCapture") {
    if (pending && pending.origin !== origin) await detachOffer(tab);
    return {
      enabled: true,
      pending: pending?.origin === origin,
      watch: attempt?.origin === origin,
    };
  }

  const username =
    typeof m.username === "string" ? m.username.trim().slice(0, 512) : "";
  const expires = Date.now() + lifetime;
  if (m.type === "attempt") {
    if (!["Email", "Provider", "Passkey"].includes(m.method)) return false;
    await memory.set({
      [attemptKey]: {
        origin,
        tab,
        method: m.method,
        provider: providerName(m.method, m.provider),
        username,
        expires,
      },
    });
    await expireAt(expires);
    return { watch: true };
  }

  let login;
  if (m.type === "completed") {
    if (attempt?.origin !== origin) return false;
    await memory.remove(attemptKey);
    login = {
      method: attempt.method,
      provider: attempt.provider,
      username: attempt.username || username,
      password: "",
    };
  } else {
    if (
      typeof m.password !== "string" ||
      !m.password ||
      m.password.length > 4096
    )
      return false;
    const account =
      username || (attempt?.origin === origin ? attempt.username : "");
    if (!account) return false;
    if (attempt?.origin === origin) await memory.remove(attemptKey);
    login = {
      method: "Password",
      provider: "",
      username: account,
      password: m.password,
    };
  }

  const entries = await unseal(record, key);
  const previous = matchingLogin(entries, { ...login, origin });
  if (previous && previous.password === login.password) return false;
  if (
    pending?.origin === origin &&
    Object.keys(login).every((field) => login[field] === pending[field])
  )
    return false;

  const id = crypto.randomUUID();
  await memory.set({
    [draftKey]: { tab, id },
    [offerKey(id)]: {
      ...login,
      origin,
      tab,
      expires,
      id,
      existingId: previous?.id ?? null,
    },
  });
  await expireAt(expires);
  await browserAPI.action.setBadgeText({ tabId: tab, text: "SAVE" });
  return { promptId: id };
}

async function showPrompt(tab, id) {
  const [active] = await browserAPI.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (active?.id !== tab || active.incognito) return;

  const draft = await serialized(async () => {
    const s = await clean();
    const draft = offerForTab(s, tab);
    if (!draft || draft.prompted || (id && draft.id !== id)) return null;
    if (originOf(active.url) && originOf(active.url) !== draft.origin)
      return null;
    await memory.set({ [offerKey(draft.id)]: { ...draft, prompted: true } });
    return draft;
  });
  if (!draft) return;

  // Background calls to openPopup depend on the browser and its version.
  if (browserAPI.action.openPopup) {
    try {
      await browserAPI.action.openPopup({ windowId: active.windowId });
      return;
    } catch {}
  }
  const [stillActive] = await browserAPI.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (stillActive?.id !== tab) return;
  await browserAPI.tabs.create({
    windowId: active.windowId,
    url: browserAPI.runtime.getURL(
      "vault.html?tab=" + tab + "&review=" + draft.id,
    ),
  });
}
async function handle(m, sender) {
  if (sender.tab?.incognito)
    throw Error("Aprion is unavailable in private windows.");
  const ui = [extension + "popup.html", extension + "vault.html"].includes(
    sender.url?.split(/[?#]/)[0],
  );
  const s = await clean();
  const record = (await local.get("vault")).vault;
  const key = record && (record.deviceKey || s.key);
  const requiresPassword = !!record && !record.deviceKey;
  if (!ui) {
    if (!sender.tab || sender.frameId !== 0)
      throw Error("Top-level tab required.");
    const handoff = providerJob(s, sender.tab.id);
    if (
      ["providerIdentity", "providerPick", "providerReturned"].includes(m.type)
    )
      return providerMessage(handoff, m, sender, record, key);
    if (["canCapture", "capture", "attempt", "completed"].includes(m.type)) {
      if (handoff && key) {
        const origin = originOf(sender.url);
        if (origin === handoff.origin && sender.tab.id === handoff.tab)
          return m.type === "canCapture"
            ? { providerReturn: handoff.handoff }
            : false;
        const hosts = identityHosts.get(handoff.provider.toLowerCase());
        if (
          hosts &&
          !hosts.includes(origin) &&
          origin !== handoff.origin &&
          !handoff.chooserCancelled
        ) {
          // An unrelated document in this tab cannot start another automatic choice.
          handoff.chooserCancelled = true;
          await memory.set({ ["job:" + handoff.origin]: handoff });
        }
        return m.type === "canCapture" ? { resumeAt: handoff.expires } : false;
      }
      return draftFor(sender, m, s, record, key);
    }
    const job = s["job:" + originOf(sender.url)];
    if (
      m.type !== "advance" ||
      !key ||
      !job ||
      job.tab !== sender.tab.id ||
      job.filled
    )
      return false;
    return advance(job, await unseal(record, key));
  }
  if (m.type === "status")
    return { exists: !!record, unlocked: !!key, requiresPassword };
  if (m.type === "create") {
    if (record) throw Error("This vault is already set up.");
    return setProtection([], m.password);
  }
  if (m.type === "unlock" && requiresPassword) {
    const passwordKey = await deriveKey(m.password, record.salt);
    await unseal(record, passwordKey);
    return touch(passwordKey);
  }
  if (m.type === "lock" && requiresPassword) return lock();
  if (!key) throw Error("Unlock your vault to continue.");
  if (m.type === "touch") return requiresPassword ? touch() : undefined;
  const entries = await unseal(record, key);
  if (m.type === "protection") {
    if (requiresPassword) {
      if (m.password !== null)
        throw Error("A master password is already enabled.");
      const currentKey = await deriveKey(m.currentPassword, record.salt);
      await unseal(record, currentKey);
    }
    return setProtection(entries, m.password);
  }
  const write = async (rows) =>
    local.set({ vault: await seal(rows, key, record) });
  const entry = entries.find((e) => e.id === m.id);
  const origin = originOf(m.origin);
  const candidate = offerForTab(s, m.tab);
  const draft = m.draftId
    ? s[offerKey(m.draftId)]
    : candidate?.origin === origin
      ? candidate
      : null;
  switch (m.type) {
    case "list":
      return entries.map(publicEntry);
    case "detail":
      if (!entry) throw Error("Account no longer exists.");
      return entry;
    case "save": {
      if (!origin || !m.username?.trim() || !methods.includes(m.method))
        throw Error("Enter a valid HTTPS website and username.");
      if (
        m.expectedUpdated !== undefined &&
        entry?.updated !== m.expectedUpdated
      )
        throw Error(
          "This account changed in another view. Close and reopen it to edit the latest version.",
        );
      if (m.id && !entry) throw Error("Account no longer exists.");
      if (
        m.draftId &&
        (!draft || draft.id !== m.draftId || draft.origin !== origin)
      )
        throw Error(
          "This save offer expired or was already handled. You can add the login manually.",
        );
      const provider = providerName(m.method, m.provider);
      if (
        matchingLogin(
          entries.filter((e) => e.id !== m.id),
          { origin, username: m.username.trim(), method: m.method, provider },
        )
      )
        throw Error("That sign-in is already saved for this website.");
      if (m.method === "Provider" && !provider)
        throw Error("Enter the sign-in provider name for this account.");
      if (m.method === "Password" && !m.password)
        throw Error("Enter the password for this account.");
      const data = {
        id: entry?.id || crypto.randomUUID(),
        origin,
        username: m.username.trim(),
        label: m.label.trim() || m.username.trim(),
        method: m.method,
        provider,
        password: m.method === "Password" ? m.password : "",
        updated: Date.now(),
      };
      if (entry && s["job:" + entry.origin]?.id === entry.id)
        await memory.remove("job:" + entry.origin);
      await write([data, ...entries.filter((e) => e.id !== data.id)]);
      if (draft && (m.draftId || draft.username === data.username))
        await dismiss();
      return data.id;
    }
    case "delete":
      if (entry && s["job:" + entry.origin]?.id === entry.id)
        await memory.remove("job:" + entry.origin);
      await write(entries.filter((e) => e.id !== m.id));
      return;
    case "draft": {
      if (!draft || !m.beginReview) return draft;
      const review = {
        ...draft,
        expires: Math.max(draft.expires, Date.now() + reviewLifetime),
      };
      await memory.set({ [offerKey(draft.id)]: review });
      await expireAt(review.expires);
      return review;
    }
    case "dismiss":
      if (m.draftId && draft?.id !== m.draftId) return;
      return dismiss();
    case "site": {
      const pending =
        candidate && (!origin || candidate.origin === origin)
          ? {
              id: candidate.id,
              origin: candidate.origin,
              username: candidate.username,
              method: candidate.method,
              provider: candidate.provider,
              existingId: candidate.existingId,
            }
          : null;
      const job = s["job:" + origin];
      let current;
      if (m.tab && origin) {
        const info = await execute(m.tab, interactWithSite, [origin, {}]).catch(
          () => null,
        );
        if (info?.signedIn) current = info.email;
      }
      return {
        enabled: !(await promptsDisabled()).includes(origin),
        pending,
        last: s["last:" + origin],
        message: job?.message,
        current,
      };
    }
    case "prompts": {
      if (!origin) throw Error("Open an HTTPS website first.");
      const disabled = new Set(await promptsDisabled());
      if (m.enable) disabled.delete(origin);
      else disabled.add(origin);
      await local.set({ disabledSaveSites: [...disabled] });
      if (m.enable) return;

      const pending = Object.entries(s).filter(
        ([name, value]) =>
          (name.startsWith("offer:") || name.startsWith("attempt:")) &&
          value.origin === origin,
      );
      for (const [name, value] of pending) {
        if (name.startsWith("offer:")) await discardOffer(s, value);
        else await memory.remove(name);
      }
      return;
    }
    case "switch": {
      const target = await browserAPI.tabs.get(m.tab);
      if (
        !entry ||
        target.incognito ||
        entry.origin !== origin ||
        originOf(target.url) !== origin
      )
        throw Error("The active website changed.");
      if (entry.method === "Provider" && !entry.provider?.trim())
        throw Error("Edit this account and enter its sign-in provider first.");
      const inProgress = s["job:" + origin];
      if (
        inProgress?.tab === m.tab &&
        inProgress.id === m.id &&
        !inProgress.filled
      )
        return inProgress.message;
      const previous = providerJob(s, m.tab);
      if (previous) await memory.remove("job:" + previous.origin);
      const job = {
        tab: m.tab,
        origin,
        id: entry.id,
        expires: Date.now() + lifetime,
        message: "Sign out of the website and open its sign-in form.",
      };
      await memory.set({ ["job:" + origin]: job });
      if (await advance(job, entries))
        await execute(m.tab, watchSwitch).catch(() => {});
      return job.message;
    }
    default:
      throw Error("Unknown request.");
  }
  async function dismiss() {
    if (draft) {
      await discardOffer(s, draft);
      await browserAPI.tabs
        .sendMessage(draft.tab, { type: "refreshCapture" }, { frameId: 0 })
        .catch(() => {});
    }
  }
}
browserAPI.runtime.onMessage.addListener((m, sender, reply) => {
  serialized(() => handle(m, sender)).then(
    (value) => {
      reply({ value });
      if (value?.promptId && sender.tab)
        setTimeout(
          () => showPrompt(sender.tab.id, value.promptId).catch(() => {}),
          400,
        );
    },
    (err) => reply({ error: err.message }),
  );
  return true;
});
browserAPI.tabs.onActivated.addListener(({ tabId }) =>
  showPrompt(tabId).catch(() => {}),
);
browserAPI.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    // Save prompts now use the manifest's content script on every HTTPS site.
    const scripts = await browserAPI.scripting.getRegisteredContentScripts();
    const ids = scripts
      .filter(
        (script) =>
          script.id.startsWith("save-") && script.js?.includes("capture.js"),
      )
      .map((script) => script.id);
    if (ids.length)
      await browserAPI.scripting.unregisterContentScripts({ ids });
    await local.remove("saveSites");
  });
});
browserAPI.alarms.onAlarm.addListener(() =>
  serialized(async () => {
    const s = await clean();
    const expiries = Object.values(s)
      .map((value) => value?.expires)
      .filter(Boolean);
    if (expiries.length)
      await browserAPI.alarms.create("expire", { when: Math.min(...expiries) });
  }),
);
browserAPI.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.openerTabId) || tab.incognito) return;
  serialized(async () => {
    const job = providerJob(await clean(), tab.openerTabId);
    if (
      job?.tab !== tab.openerTabId ||
      job.popup !== undefined ||
      job.identityTab !== undefined
    )
      return;
    const opener = await browserAPI.tabs.get(job.tab);
    if (originOf(opener.url) !== job.origin) return;
    job.popup = tab.id;
    await memory.set({ ["job:" + job.origin]: job });
  }).catch(() => {});
});
browserAPI.tabs.onUpdated.addListener((id, change, tab) => {
  if (!change.url && change.status !== "complete") return;
  serialized(async () => {
    const s = await clean();
    const offer = offerForTab(s, id);
    if (offer && change.url && originOf(change.url) !== offer.origin)
      await detachOffer(id);
    for (const [name, job] of Object.entries(s)) {
      if (!name.startsWith("job:") || job.tab !== id) continue;
      if (job.handoff) continue;
      if (originOf(tab.url) !== job.origin) await memory.remove(name);
      else if (change.status === "complete" && !job.filled)
        await execute(id, watchSwitch);
    }
  }).catch(() => {});
});

// Refresh the isolated form listeners when vault access or site consent changes.
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (
    !(
      (area === "session" && changes.key) ||
      (area === "local" &&
        (changes.disabledSaveSites ||
          !!changes.vault?.oldValue?.deviceKey !==
            !!changes.vault?.newValue?.deviceKey))
    )
  )
    return;
  browserAPI.tabs
    .query({})
    .then((tabs) =>
      Promise.all(
        tabs.map((tab) =>
          browserAPI.tabs
            .sendMessage(tab.id, { type: "refreshCapture" }, { frameId: 0 })
            .catch(() => {}),
        ),
      ),
    );
});
browserAPI.tabs.onRemoved.addListener((id) =>
  serialized(async () => {
    const state = await memory.get(null);
    await memory.remove(
      Object.keys(state).filter(
        (k) => !k.startsWith("offer:") && state[k]?.tab === id,
      ),
    );
  }),
);
