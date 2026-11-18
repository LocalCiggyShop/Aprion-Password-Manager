const browserAPI = globalThis.browser ?? globalThis.chrome;
const app = document.querySelector("#app");
const popup = document.body.classList.contains("popup");
const startup = document.querySelector("#startup");
const startupTime = performance.now();
const paths = {
  lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  safe: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 6v3m0 6v3m-6-6h3m6 0h3"/>',
  layers: '<path d="m3 7 9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',
  key: '<circle cx="15" cy="8" r="5"/><path d="m11 12-8 8v-4l7-7"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  copy: '<rect x="8" y="7" width="12" height="14" rx="2"/><path d="M15 7V3H3v13h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20l-5 1z"/>',
  bell: '<path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 20h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M10 9a2 2 0 1 1 3 1.7c-.8.5-1 1-1 1.8M12 16h.01"/>',
  home: '<path d="m3 10 9-8 9 8v11h-6v-7H9v7H3z"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M10 3h4l.5 2.5 2 1 2.5-.8 2 3.5-2 1.8v2l2 1.8-2 3.5-2.5-.8-2 1-.5 2.5h-4l-.5-2.5-2-1-2.5.8-2-3.5 2-1.8v-2l-2-1.8 2-3.5 2.5.8 2-1z"/>',
};
const icon = (name) =>
  '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24">' +
  paths[name] +
  "</svg>";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const brand =
  '<div class="brand"><span class="mark">' +
  icon("lock") +
  "</span><div><b>Aprion</b><small>Password vault</small></div></div>";
const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
let tab = Number(params.get("tab")) || null,
  origin = "",
  entries = [],
  selected = "",
  search = "",
  page = params.has("settings") ? "settings" : "overview",
  unlocked = false,
  requiresPassword = false,
  lastTouch = 0,
  epoch = 0;
let site = {};
const host = (value) => new URL(value).host;
const btn = (action, label, glyph, cls = "ghost") =>
  '<button type="button" class="' +
  cls +
  '" data-act="' +
  action +
  '" aria-label="' +
  esc(label) +
  '">' +
  (glyph ? icon(glyph) : "") +
  "<span>" +
  label +
  "</span></button>";
async function rpc(type, data = {}) {
  const result = await browserAPI.runtime.sendMessage({ ...data, type });
  if (result?.error) throw Error(result.error);
  return result?.value;
}
let noticeTimer;
function notice(msg) {
  const toast = $("#notice");
  toast.textContent = msg;
  toast.dataset.visible = "";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => delete toast.dataset.visible, 4400);
}
function error(err) {
  const slot = $("dialog[open] .err") || $(".auth .err");
  if (slot) slot.textContent = err.message;
  else notice(err.message);
}
const deviceAccess =
  "Anyone with access to this browser profile can open the vault.";
function passwordFields(create) {
  return `<label>Master password
    <input name="password" type="password" required ${
      create
        ? 'autocomplete="new-password" minlength="12" placeholder="At least 12 characters"'
        : 'autocomplete="current-password"'
    }>
  </label>${
    create
      ? `<label>Confirm master password
    <input name="confirm" type="password" autocomplete="new-password" required>
  </label>`
      : ""
  }`;
}
function newPassword(form) {
  if (form.elements.password.value !== form.elements.confirm.value)
    throw Error("The passwords differ. Enter them again.");
  return form.elements.password.value;
}
function renderAuth(create) {
  app.innerHTML = `<section class="${popup ? "popup-view" : "panel"} auth appear">
    ${brand}
    <h1>${create ? "Create your vault" : "Unlock your vault"}</h1>
    <p class="muted">${create ? "Store your accounts locally on this device." : "Enter your master password to access your saved logins."}</p>
    <form id="auth">
      ${
        create
          ? `<label class="setup-choice">
        <span>Require a master password</span>
        <input type="checkbox" name="requirePassword" role="switch" checked>
      </label>
      <div class="password-options">
        <fieldset>${passwordFields(true)}</fieldset>
      </div>
      <p class="device-access muted" hidden>${deviceAccess}</p>`
          : passwordFields(false)
      }
      <div class="err" role="alert"></div>
      <button class="primary wide">${icon("lock")}${create ? "Create local vault" : "Unlock vault"}</button>
    </form>
  </section>`;
  const form = $("#auth");
  if (create) {
    form.elements.requirePassword.onchange = () => {
      const enabled = form.elements.requirePassword.checked;
      const fields = form.querySelector("fieldset");
      fields.disabled = !enabled;
      fields.inert = !enabled;
      form
        .querySelector(".password-options")
        .classList.toggle("collapsed", !enabled);
      form.querySelector(".device-access").hidden = enabled;
      form.querySelector(".err").textContent = "";
    };
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    if (submit.disabled) return;
    try {
      const password = create
        ? form.elements.requirePassword.checked
          ? newPassword(form)
          : null
        : form.elements.password.value;
      submit.disabled = true;
      await rpc(create ? "create" : "unlock", { password });
      await boot();
    } catch (err) {
      error(err);
      submit.disabled = false;
    }
  };
}
async function boot() {
  const version = ++epoch;
  if (popup) {
    const [activeTab] = await browserAPI.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (version !== epoch) return;
    if (activeTab?.incognito) {
      app.innerHTML = `<section class="popup-view auth appear">${brand}<p>Aprion is unavailable in private windows.</p></section>`;
      return;
    }
    tab = activeTab?.id;
  }
  const state = await rpc("status");
  if (version !== epoch) return;
  unlocked = state.unlocked;
  requiresPassword = state.requiresPassword;
  if (!unlocked) {
    entries = [];
    selected = "";
    site = {};
    search = "";
    $("#notice").textContent = "";
    delete $("#notice").dataset.visible;
    renderAuth(!state.exists);
    return;
  }
  const url = tab && (await browserAPI.tabs.get(tab).catch(() => null))?.url;
  origin = url?.startsWith("https://") ? new URL(url).origin : "";
  await reload(true);
  if (version !== epoch) return;
  if (!popup && (params.has("add") || params.has("review"))) {
    const draftId = params.get("review");
    params.delete("add");
    params.delete("review");
    history.replaceState({}, "", location.pathname);
    await edit(null, true, draftId);
  }
}
async function reload(animate = false) {
  const version = epoch;
  const data = await rpc("list");
  const info = popup && tab ? await rpc("site", { origin, tab }) : {};
  if (version !== epoch || !unlocked) return;
  entries = data;
  site = info;
  if (!entries.some((e) => e.id === selected)) selected = entries[0]?.id || "";
  if (popup) renderPopup(animate);
  else renderVault(animate);
}
function row(e, i, detail = false) {
  const current =
    !detail && site.current?.toLowerCase() === e.username.toLowerCase();
  const last = !detail && site.last === e.id;
  return (
    '<button class="row ' +
    (current ? "active" : detail && selected === e.id ? "selected" : "") +
    '" data-act="' +
    (detail ? "select" : "switch") +
    '" data-id="' +
    esc(e.id) +
    '"><span class="avatar av' +
    (i % 3) +
    '">' +
    esc(Array.from(e.label)[0].toUpperCase()) +
    "</span><span><b>" +
    esc(e.label) +
    "</b><small>" +
    esc(e.username) +
    "</small></span>" +
    (detail ? '<span class="domain">' + esc(host(e.origin)) + "</span>" : "") +
    (current
      ? '<span class="end">✓ Signed in</span>'
      : last
        ? '<span class="end">Last used</span>'
        : "") +
    "</button>"
  );
}
function renderPopup(animate) {
  const matches = entries.filter((e) => e.origin === origin);
  app.innerHTML =
    '<section class="popup-view picker' +
    (animate ? " appear" : "") +
    '"><header class="brand sitehead"><span class="mark">' +
    icon("lock") +
    "</span><div><b>" +
    esc(origin ? host(origin) : "Aprion") +
    '</b><small>Site accounts</small></div></header><div class="box">' +
    (matches.length
      ? matches.map((e, i) => row(e, i)).join("")
      : '<p class="empty">' +
        (origin
          ? "No saved accounts for this site."
          : "Open a website to pick an account.") +
        "</p>") +
    '<div class="menulist">' +
    btn("manage", "Manage accounts", "layers", "menu") +
    btn("add", "Add login account", "plus", "menu") +
    (origin
      ? `<div class="prompt-option">
        ${btn("prompts", (site.enabled ? "Disable" : "Enable") + " save prompts for this site", "bell", "menu")}
        <div class="prompt-help">
          <button class="ghost" type="button" aria-label="About save prompts" aria-describedby="save-prompts-help">${icon("help")}</button>
          <span class="tooltip" id="save-prompts-help" role="tooltip">Aprion offers to save new logins or update changed passwords you submit while the vault is unlocked. You choose what gets saved.</span>
        </div>
      </div>`
      : "") +
    btn("settings", "Settings", "settings", "menu") +
    (requiresPassword ? btn("lock", "Lock vault", "lock", "menu") : "") +
    '</div></div><p class="status">' +
    esc(site.message || "") +
    "</p></section>";
  const help = $(".prompt-help");
  if (help) {
    const resetTooltip = () => delete help.dataset.dismissed;
    help.addEventListener("mouseleave", resetTooltip);
    help.addEventListener("focusout", resetTooltip);
  }
  if (site.pending) {
    const offer = site.pending;
    const method = offer.provider || offer.method;
    $(".picker").insertAdjacentHTML(
      "afterbegin",
      `<div class="pending"><b>${offer.existingId ? "Update password?" : "Save this sign-in?"}</b>
        <div>${esc(host(offer.origin))} · ${esc(method)}</div>
        ${offer.username ? `<div>${esc(offer.username)}</div>` : ""}
        <div class="actions">${btn("review", "Review and save", null, "primary")}${btn("dismiss", "Don’t save")}</div>
      </div>`,
    );
  }
}
function renderVault(animate) {
  const settings = page === "settings";
  const sites = new Set(entries.map((e) => e.origin)).size;
  app.innerHTML =
    '<div class="layout"><aside class="rail">' +
    brand +
    '<nav aria-label="Vault navigation">' +
    btn(
      "overview",
      "Overview",
      "home",
      page === "overview" ? "chosen" : "ghost",
    ) +
    btn(
      "accounts",
      "Saved accounts",
      "layers",
      page === "accounts" ? "chosen" : "ghost",
    ) +
    btn("settings", "Settings", "settings", settings ? "chosen" : "ghost") +
    "</nav><footer>" +
    (requiresPassword ? btn("lock", "Lock vault", "lock") : "") +
    '</footer></aside><div><header class="top">' +
    (settings
      ? ""
      : '<div class="search">' +
        icon("search") +
        '<input id="search" aria-label="Search accounts" placeholder="Search websites, accounts, or emails…" value="' +
        esc(search) +
        '"><kbd class="key">Ctrl K</kbd></div>') +
    '<small>Local vault</small></header><section class="content' +
    (animate ? " appear" : "") +
    '"><h1>' +
    (settings
      ? "Settings"
      : page === "overview"
        ? "Vault overview"
        : "Saved accounts") +
    "</h1>" +
    (page === "overview"
      ? '<div class="stats"><div class="hero panel"><span class="safe">' +
        icon("safe") +
        '</span><div><h2>Your vault</h2><small>Encrypted on this device</small></div></div><div class="stat panel">' +
        icon("key") +
        "<div><strong>" +
        entries.length +
        '</strong><br><small>Saved accounts</small></div></div><div class="stat panel">' +
        icon("globe") +
        "<div><strong>" +
        sites +
        "</strong><br><small>Websites</small></div></div></div>"
      : "") +
    (settings
      ? `<section class="panel protection">
      <h2>Master password</h2>
      <p class="muted">${requiresPassword ? "Required to open your vault after locking or restarting your browser." : deviceAccess}</p>
      ${btn("protection", requiresPassword ? "Remove master password" : "Set master password", "lock", requiresPassword ? "ghost" : "primary")}
    </section>`
      : '<div class="columns"><section class="panel accountlist"><header class="listhead flex between"><h2>Saved logins</h2>' +
        btn("add", "Add login", "plus", "primary") +
        '</header><div class="items"></div></section><section class="panel detail"></section></div>') +
    "</section></div></div>";
  if (settings) return;
  $("#search").oninput = (e) => {
    search = e.target.value;
    renderItems();
  };
  renderItems();
}
function renderItems() {
  const filtered = entries.filter((e) =>
    [e.label, e.username, host(e.origin)].some((v) =>
      v.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  if (!filtered.some((e) => e.id === selected))
    selected = filtered[0]?.id || "";
  $(".items").innerHTML =
    filtered.map((e, i) => row(e, i, true)).join("") ||
    '<p class="empty">' +
      (entries.length
        ? "No matching accounts."
        : "Add your first login to see it here.") +
      "</p>";
  const e = entries.find((e) => e.id === selected);
  if (!e) {
    $(".detail").innerHTML =
      '<div class="empty">' +
      icon("safe") +
      "<p>Account details appear here.</p></div>";
    return;
  }
  $(".detail").innerHTML =
    btn("back", "Back to accounts", null, "ghost back") +
    '<div class="brandline"><span class="avatar">' +
    esc(Array.from(e.label)[0].toUpperCase()) +
    "</span><div><h2>" +
    esc(e.label) +
    "</h2><small>" +
    esc(host(e.origin)) +
    '</small></div></div><div class="field"><small>Username</small><div class="flex between"><strong>' +
    esc(e.username) +
    "</strong>" +
    btn("copyUser", "Copy", "copy") +
    "</div></div>" +
    (e.hasPassword
      ? '<div class="field"><small>Password</small><div class="flex between"><strong id="secret">••••••••</strong><div class="flex">' +
        btn("reveal", "Show", "eye") +
        btn("copyPass", "Copy", "copy") +
        "</div></div></div>"
      : "") +
    '<div class="field"><small>Sign-in method</small>' +
    esc(e.provider ? `${e.method} · ${e.provider}` : e.method) +
    '</div><div class="actions">' +
    btn("edit", "Edit", "edit") +
    btn("delete", "Delete", null, "ghost danger") +
    "</div>";
}
function modal(content) {
  $("dialog")?.remove();
  const d = document.createElement("dialog");
  d.innerHTML = content;
  app.append(d);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(d);
  });
  d.showModal();
  return d;
}
async function playExit(element) {
  element.dataset.closing = "";
  await Promise.allSettled(
    element.getAnimations().map((animation) => animation.finished),
  );
}
async function closeDialog(dialog) {
  if (dialog.hasAttribute("data-closing")) return;
  dialog.inert = true;
  await playExit(dialog);
  dialog.close();
  dialog.remove();
}
function changeProtection() {
  const removing = requiresPassword;
  const dialog =
    modal(`<h2>${removing ? "Remove master password?" : "Set master password"}</h2>
    <p class="muted">${removing ? deviceAccess : "Use this password to unlock your vault."}</p>
    <form>
      ${passwordFields(!removing)}
      <div class="err" role="alert"></div>
      <div class="actions">
        ${btn("close", "Cancel")}
        <button class="primary">${removing ? "Remove password" : "Set password"}</button>
      </div>
    </form>`);
  const form = dialog.querySelector("form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector(".primary");
    if (submit.disabled) return;
    try {
      const password = removing ? null : newPassword(form);
      submit.disabled = true;
      await rpc("protection", {
        password,
        currentPassword: removing ? form.elements.password.value : undefined,
      });
      if (dialog.isConnected) await closeDialog(dialog);
      await boot();
      notice(removing ? "Master password removed" : "Master password set");
    } catch (err) {
      submit.disabled = false;
      error(err);
    }
  };
}
async function edit(id, recall = false, draftId = null) {
  const pending =
    recall &&
    (origin || draftId) &&
    (await rpc("draft", { origin, tab, draftId, beginReview: true }));
  const expired = draftId && !pending;
  const old = id || pending?.existingId;
  const entry = old ? await rpc("detail", { id: old }) : {};
  const data = { ...entry, ...(pending || {}) };
  const d = modal(
    "<h2>" +
      (pending
        ? old
          ? "Update password?"
          : "Save this sign-in?"
        : old
          ? "Edit login account"
          : "Add login account") +
      "</h2>" +
      (expired
        ? '<p class="muted">That save offer expired or was already handled. You can enter the sign-in details here.</p>'
        : "") +
      '<form><label>Website<input required name="origin" placeholder="Website address"></label><label>Account label<input name="label" placeholder="Personal or Work"></label><label>Email or username<input required name="username" autocomplete="off"></label><label>Sign-in method<select name="method">' +
      ["Password", "Email", "Provider", "Passkey"]
        .map((v) => "<option>" + v + "</option>")
        .join("") +
      '</select></label><label id="providerlabel">Provider<input name="provider" maxlength="60" placeholder="Google, GitHub or Microsoft"></label><label id="pwlabel">Password<input name="password" type="password" autocomplete="new-password"></label><div class="err" role="alert"></div><div class="actions">' +
      (pending ? btn("discard-offer", "Don’t save") : btn("close", "Cancel")) +
      '<button class="primary">Save account</button></div></form>',
  );
  const f = d.querySelector("form");
  if (pending) d.dataset.draftId = pending.id;
  f.elements.origin.value = data.origin || (expired ? "" : origin);
  f.elements.origin.readOnly = !!pending;
  f.elements.label.value = data.label || "";
  f.elements.username.value = data.username || "";
  f.elements.password.value = data.password || "";
  f.elements.provider.value = data.provider || "";
  f.elements.method.value = data.method || "Password";
  const method = () => {
    $("#pwlabel").hidden = f.elements.method.value !== "Password";
    $("#providerlabel").hidden = f.elements.method.value !== "Provider";
    f.elements.password.required = !$("#pwlabel").hidden;
  };
  f.elements.method.onchange = method;
  method();
  f.onsubmit = async (event) => {
    event.preventDefault();
    const submit = f.querySelector(".primary");
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const fields = Object.fromEntries(new FormData(f));
      if (!fields.origin.includes("://"))
        fields.origin = "https://" + fields.origin;
      selected = await rpc("save", {
        ...fields,
        id: old || undefined,
        expectedUpdated: entry.updated,
        draftId: pending?.id,
        tab,
      });
      await closeDialog(d);
      await reload();
      notice("Account saved");
    } catch (err) {
      submit.disabled = false;
      error(err);
    }
  };
}
async function action(a, button) {
  if (a === "close") return closeDialog($("dialog"));
  if (a === "discard-offer") {
    const dialog = $("dialog");
    await rpc("dismiss", { tab, draftId: dialog.dataset.draftId });
    return closeDialog(dialog);
  }
  if (a === "lock") {
    await rpc("lock");
    return boot();
  }
  if (popup && ["manage", "add", "review", "settings"].includes(a)) {
    if (app.hasAttribute("data-closing")) return;
    const query =
      a === "review"
        ? "?tab=" + tab + "&review=" + site.pending.id
        : a === "settings"
          ? "?settings=1"
          : a === "add"
            ? "?add=1&tab=" + tab
            : "";
    await playExit(app);
    try {
      await browserAPI.tabs.create({
        url: browserAPI.runtime.getURL("vault.html") + query,
      });
      window.close();
    } finally {
      delete app.dataset.closing;
    }
    return;
  }
  if (a === "select") {
    selected = button.dataset.id;
    renderItems();
    $(".columns").classList.add("show-detail");
    $(".detail").classList.add("appear");
    return;
  }
  if (a === "back") {
    $(".columns").classList.remove("show-detail");
    $(".accountlist").classList.add("appear");
    return;
  }
  if (["accounts", "overview", "settings"].includes(a)) {
    if (a === page) return;
    const restoreFocus = button.matches(":focus-visible");
    page = a;
    renderVault(true);
    if (restoreFocus) $(`.rail [data-act="${page}"]`).focus();
    return;
  }
  if (a === "protection") return changeProtection();
  if (a === "add" || a === "edit") return edit(a === "edit" ? selected : null);
  if (a === "delete") {
    const id = selected;
    const d = modal(
      '<h2>Delete this account?</h2><p class="muted">' +
        esc(entries.find((e) => e.id === id).username) +
        ' will be removed from your local vault.</p><div class="actions">' +
        btn("close", "Cancel") +
        '<button id="confirm" class="danger">Delete account</button></div>',
    );
    $("#confirm").onclick = async () => {
      try {
        await rpc("delete", { id });
        await closeDialog(d);
        await reload();
      } catch (err) {
        error(err);
      }
    };
    return;
  }
  if (a === "copyUser" || a === "copyPass" || a === "reveal") {
    if (a === "reveal" && button.dataset.shown) {
      renderItems();
      return;
    }
    const e = await rpc("detail", { id: selected });
    if (a === "reveal") {
      $("#secret").textContent = e.password;
      button.dataset.shown = "yes";
      button.querySelector("span").textContent = "Hide";
      return;
    }
    await navigator.clipboard.writeText(
      a === "copyUser" ? e.username : e.password,
    );
    notice("Copied to clipboard");
    return;
  }
  if (a === "dismiss") {
    await rpc("dismiss", { tab, origin, draftId: site.pending?.id });
    return reload();
  }
  if (a === "prompts") {
    await rpc("prompts", { origin, tab, enable: !site.enabled });
    return reload();
  }
  if (a === "switch") {
    button.disabled = true;
    try {
      await rpc("switch", { id: button.dataset.id, origin, tab });
      await reload();
    } finally {
      button.disabled = false;
    }
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) action(b.dataset.act, b).catch(error);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const help = $(".prompt-help:hover, .prompt-help:focus-within");
    if (help && !help.hasAttribute("data-dismissed")) {
      help.dataset.dismissed = "";
      e.preventDefault();
      return;
    }
  }
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "k" &&
    $("#search") &&
    !$("dialog")
  ) {
    e.preventDefault();
    $("#search").focus();
  }
});
for (const event of ["pointerdown", "keydown", "input"])
  document.addEventListener(
    event,
    () => {
      if (unlocked && requiresPassword && Date.now() - lastTouch > 15000) {
        lastTouch = Date.now();
        rpc("touch").catch(() => boot());
      }
    },
    true,
  );
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (
    (area === "session" && changes.key) ||
    (area === "local" &&
      !!changes.vault?.oldValue?.deviceKey !==
        !!changes.vault?.newValue?.deviceKey)
  ) {
    boot().catch(error);
    return;
  }
  if (!unlocked || $("dialog")) return;
  if (
    (area === "local" && changes.vault) ||
    (popup &&
      area === "session" &&
      Object.keys(changes).some(
        (k) => k.startsWith("job:") || k.startsWith("draft:"),
      ))
  )
    reload().catch(error);
});
boot()
  .catch(error)
  .finally(async () => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, 210 - (performance.now() - startupTime)),
        ),
      );
    }
    startup.dataset.ready = "";
    await Promise.allSettled(
      startup.getAnimations().map((animation) => animation.finished),
    );
    startup.remove();
    app.removeAttribute("aria-busy");
  });
