import { deriveKey, protect, seal, unseal } from "./crypto.js";
import { interactWithSite, watchSwitch } from "./site.js";

const browserAPI = globalThis.browser ?? globalThis.chrome;
const local = browserAPI.storage.local;
const memory = browserAPI.storage.session; // Trusted extension contexts only, cleared on browser restart.
const idle = 10 * 60_000;
const lifetime = 120_000;
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
async function clean() {
  const s = await memory.get(null);
  if (s.key && s.deadline <= Date.now()) {
    await lock();
    return {};
  }
  for (const [k, v] of Object.entries(s)) {
    if (v?.expires <= Date.now()) {
      await memory.remove(k);
      if (k.startsWith("draft:"))
        await browserAPI.action
          .setBadgeText({ tabId: v.tab, text: "" })
          .catch(() => {});
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
  const site = await execute(job.tab, interactWithSite, [
    job.origin,
    { openMenu: !job.opened && !job.logout && !job.filled },
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
  } else if (!loginPage && !job.filled) {
    if (
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
    if (delegated) {
      job.message =
        "Choose " +
        entry.username +
        " using " +
        (entry.provider || entry.method.toLowerCase()) +
        " sign-in.";
      job.filled = true;
    } else {
      const { stage: result } = await execute(job.tab, interactWithSite, [
        job.origin,
        {
          action: "fill",
          documentToken: site.documentToken,
          entry: { username: entry.username, password: entry.password },
          stage: job.stage || "username",
        },
      ]);
      if (result) {
        job.stage = result;
        job.message =
          result === "password"
            ? "Email filled. Continue to the password step."
            : "Login filled. Review and submit on the website.";
        job.filled = result === "done";
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
  if (m.type === "canCapture") {
    if (s[draftKey] && s[draftKey].origin !== origin) {
      await memory.remove(draftKey);
      await browserAPI.action.setBadgeText({ tabId: tab, text: "" });
    }
    return {
      enabled: true,
      pending: s[draftKey]?.origin === origin,
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
  const pending = s[draftKey];
  if (
    pending?.origin === origin &&
    Object.keys(login).every((field) => login[field] === pending[field])
  )
    return false;

  const id = crypto.randomUUID();
  await memory.set({
    [draftKey]: {
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
    const draftKey = "draft:" + tab;
    const draft = s[draftKey];
    if (!draft || draft.prompted || (id && draft.id !== id)) return null;
    if (originOf(active.url) && originOf(active.url) !== draft.origin)
      return null;
    await memory.set({ [draftKey]: { ...draft, prompted: true } });
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
    if (["canCapture", "capture", "attempt", "completed"].includes(m.type))
      return draftFor(sender, m, s, record, key);
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
  const draftKey = "draft:" + m.tab;
  const candidate = s[draftKey];
  const draft =
    candidate && (candidate.origin === origin || candidate.id === m.draftId)
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
        throw Error("This save offer is no longer available.");
      const provider = providerName(m.method, m.provider);
      if (
        matchingLogin(
          entries.filter((e) => e.id !== m.id),
          { origin, username: m.username.trim(), method: m.method, provider },
        )
      )
        throw Error("That sign-in is already saved for this website.");
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
      await write([data, ...entries.filter((e) => e.id !== data.id)]);
      if (draft && (m.draftId || draft.username === data.username))
        await dismiss();
      return data.id;
    }
    case "delete":
      await write(entries.filter((e) => e.id !== m.id));
      return;
    case "draft":
      return draft;
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
          (name.startsWith("draft:") || name.startsWith("attempt:")) &&
          value.origin === origin,
      );
      await memory.remove(pending.map(([name]) => name));
      await Promise.all(
        pending.map(([name, value]) => {
          if (name.startsWith("draft:"))
            return browserAPI.action
              .setBadgeText({ tabId: value.tab, text: "" })
              .catch(() => {});
        }),
      );
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
    await memory.remove(draftKey);
    await browserAPI.action
      .setBadgeText({ tabId: m.tab, text: "" })
      .catch(() => {});
    if (m.tab)
      await browserAPI.tabs
        .sendMessage(m.tab, { type: "refreshCapture" }, { frameId: 0 })
        .catch(() => {});
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
browserAPI.tabs.onUpdated.addListener((id, change, tab) => {
  if (!change.url && change.status !== "complete") return;
  serialized(async () => {
    const s = await clean();
    for (const [name, job] of Object.entries(s)) {
      if (
        job?.tab === id &&
        name.startsWith("draft:") &&
        change.url &&
        originOf(change.url) !== job.origin
      ) {
        await memory.remove(name);
        await browserAPI.action.setBadgeText({ tabId: id, text: "" });
      }
      if (!name.startsWith("job:") || job.tab !== id) continue;
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
    await memory.remove(Object.keys(state).filter((k) => state[k]?.tab === id));
  }),
);
