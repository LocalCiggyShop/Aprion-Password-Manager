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
        entry.method.toLowerCase() +
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
async function draftFor(sender, m, s, record, key) {
  const origin = originOf(sender.url);
  if (!key || !origin || (await promptsDisabled()).includes(origin))
    return false;
  if (m.type === "canCapture")
    return {
      enabled: true,
      pending: s["draft:" + sender.tab.id]?.origin === origin,
    };
  const tab = sender.tab.id;
  const stepKey = "identity:" + tab;
  if (
    m.type === "identity" &&
    typeof m.username === "string" &&
    m.username.length <= 512
  ) {
    await memory.set({
      [stepKey]: {
        origin,
        username: m.username.trim(),
        expires: Date.now() + lifetime,
      },
    });
    return false;
  }
  if (!m.username && s[stepKey]?.origin === origin)
    m.username = s[stepKey].username;
  if (m.password) await memory.remove(stepKey);
  if (
    !m.username?.trim() ||
    typeof m.password !== "string" ||
    m.password.length > 4096 ||
    m.username.length > 512
  )
    return false;
  const entries = await unseal(record, key);
  const previous = entries.find(
    (e) => e.origin === origin && e.username === m.username,
  );
  if (previous && (!m.password || previous.password === m.password))
    return false;
  const expires = Date.now() + lifetime;
  await memory.set({
    ["draft:" + tab]: {
      origin,
      username: m.username,
      password: m.password,
      tab,
      expires,
    },
  });
  await browserAPI.alarms.create("expire", {
    when: Math.min(
      expires,
      (await browserAPI.alarms.get("expire"))?.scheduledTime || expires,
    ),
  });
  await browserAPI.action.setBadgeText({ tabId: tab, text: "SAVE" });
  return true;
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
    if (["canCapture", "capture", "identity"].includes(m.type))
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
  const draft = s[draftKey]?.origin === origin ? s[draftKey] : null;
  switch (m.type) {
    case "list":
      return entries.map(publicEntry);
    case "detail":
      if (!entry) throw Error("Account no longer exists.");
      return entry;
    case "save": {
      if (
        !origin ||
        !m.username?.trim() ||
        !["Password", "Email", "Provider", "Passkey"].includes(m.method)
      )
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
        entries.some(
          (e) =>
            e.id !== m.id &&
            e.origin === origin &&
            e.username === m.username.trim(),
        )
      )
        throw Error("That login already exists for this website.");
      if (m.method === "Password" && !m.password)
        throw Error("Enter the password for this account.");
      const data = {
        id: entry?.id || crypto.randomUUID(),
        origin,
        username: m.username.trim(),
        label: m.label.trim() || m.username.trim(),
        method: m.method,
        password: m.method === "Password" ? m.password : "",
        updated: Date.now(),
      };
      await write([data, ...entries.filter((e) => e.id !== data.id)]);
      if (draft && draft.username === data.username) await dismiss();
      return data.id;
    }
    case "delete":
      await write(entries.filter((e) => e.id !== m.id));
      return;
    case "draft":
      return draft;
    case "dismiss":
      return dismiss();
    case "site": {
      if (!origin) return {};
      const job = s["job:" + origin];
      let current;
      if (m.tab) {
        const info = await execute(m.tab, interactWithSite, [origin, {}]).catch(
          () => null,
        );
        if (info?.signedIn) current = info.email;
      }
      return {
        enabled: !(await promptsDisabled()).includes(origin),
        pending: draft?.username,
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
          (name.startsWith("draft:") || name.startsWith("identity:")) &&
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
  }
}
browserAPI.runtime.onMessage.addListener((m, sender, reply) => {
  serialized(() => handle(m, sender)).then(
    (value) => reply({ value }),
    (err) => reply({ error: err.message }),
  );
  return true;
});
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
      if (
        name === "identity:" + id &&
        change.url &&
        originOf(change.url) !== job.origin
      )
        await memory.remove(name);
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
    await memory.remove(
      Object.keys(state).filter(
        (k) => state[k]?.tab === id || k === "identity:" + id,
      ),
    );
  }),
);
