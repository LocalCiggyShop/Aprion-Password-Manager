const fs = require("fs"),
  os = require("os"),
  path = require("path"),
  cp = require("child_process"),
  assert = require("assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aprion-brave-test-"));
const ext = path.resolve(__dirname, "../extension");
const executable =
  process.env.BRAVE_PATH ||
  (process.platform === "win32"
    ? path.join(
        process.env.ProgramFiles,
        "BraveSoftware/Brave-Browser/Application/brave.exe",
      )
    : process.platform === "darwin"
      ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
      : "brave-browser");
const launch = () =>
  cp.spawn(
    executable,
    [
      "--headless=new",
      "--enable-unsafe-extension-debugging",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--user-data-dir=" + dir,
      "--load-extension=" + ext,
      "--disable-extensions-except=" + ext,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
let brave, client;
async function run(restartId, deviceSetup = false) {
  brave = launch();
  const portFile = path.join(dir, "DevToolsActivePort");
  let ver;
  for (let i = 0; i < 150 && !ver; i++) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
      ver = await (
        await fetch("http://127.0.0.1:" + port + "/json/version")
      ).json();
    } catch {
      await sleep(100);
    }
  }
  assert(ver, "Brave debugging endpoint started");
  console.log("Brave engine:", ver.Browser);
  client = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (client.onopen = r));
  let seq = 0;
  const pending = new Map();
  function cmd(method, params = {}, sessionId) {
    return new Promise((ok, bad) => {
      pending.set(++seq, { ok, bad });
      client.send(JSON.stringify({ id: seq, method, params, sessionId }));
    });
  }

  client.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.bad(Error(m.error.message)) : p.ok(m.result);
    }
  };
  if (restartId)
    await cmd("Target.createTarget", {
      url: "chrome-extension://" + restartId + "/vault.html",
    });
  let targets;
  for (let i = 0; i < 60; i++) {
    targets = (await cmd("Target.getTargets")).targetInfos;
    if (targets.some((t) => t.url.endsWith("background.js"))) break;
    await sleep(100);
  }
  const sw = targets.find((t) => t.url.endsWith("background.js"));
  assert(
    sw,
    "background worker loaded " + JSON.stringify(targets.map((t) => t.type)),
  );
  const id = new URL(sw.url).hostname;
  console.log("Extension loaded");
  async function attach(t) {
    return (await cmd("Target.attachToTarget", { targetId: t, flatten: true }))
      .sessionId;
  }
  async function page(url) {
    const t = (await cmd("Target.createTarget", { url })).targetId;
    const s = await attach(t);
    await sleep(250);
    return s;
  }
  async function ev(s, expression) {
    const r = await cmd(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      s,
    );
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return r.result.value;
  }
  const vault = await page("chrome-extension://" + id + "/vault.html");
  async function until(fn, msg) {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await sleep(100);
    }
    throw Error(msg);
  }
  const has = (sel) =>
    ev(vault, "!!document.querySelector(" + JSON.stringify(sel) + ")");
  async function restart() {
    const exited = new Promise((resolve) => brave.once("exit", resolve));
    await cmd("Browser.close");
    await exited;
    client.close();
    await fs.promises.rm(portFile, { force: true });
    await run(id, deviceSetup);
  }
  if (restartId) {
    if (deviceSetup) {
      await until(
        () => has(".columns"),
        "vault opens without prompting after restart",
      );
      assert.equal(await has("[data-act=lock]"), false);
      console.log(
        "Brave passed: passwordless access persists across a restart.",
      );
      await cmd("Browser.close");
      return;
    }
    await until(
      () => has("#auth"),
      "vault starts locked after browser restart",
    );
    assert.equal(
      await has("input[name=confirm]"),
      false,
      "existing vault found",
    );
    await ev(
      vault,
      "document.querySelector('#auth').password.value='example test 4921';document.querySelector('#auth').requestSubmit()",
    );
    await until(
      () => ev(vault, "document.querySelectorAll('.items .row').length===4"),
      "saved accounts survive restart",
    );
    console.log(
      "Brave passed: browser restart locks the vault and preserves all accounts.",
    );
    return cmd("Browser.close");
  }
  await until(() => has("#auth"), "setup form");
  if (deviceSetup) {
    await ev(
      vault,
      "document.querySelector('[name=requirePassword]').click();document.querySelector('#auth').requestSubmit()",
    );
    await until(() => has(".columns"), "setup without a master password");
    const record = await ev(
      vault,
      "chrome.storage.local.get('vault').then(r=>r.vault)",
    );
    assert.equal(record.deviceKey.length, 32);
    assert.equal(await has("[data-act=lock]"), false);
    console.log("Brave passed: first-run setup without a master password.");
    return restart();
  }
  await ev(
    vault,
    `const f=document.querySelector('#auth');f.password.value=f.confirm.value='example test 4921';f.requestSubmit()`,
  );
  await until(
    async () => (await has(".columns")) && !(await has("#startup")),
    "vault unlocked",
  );
  async function add(label, email) {
    await ev(vault, `document.querySelector('[data-act=add]').click();`);
    await until(() => has("dialog form"), "entry dialog");
    await ev(
      vault,
      `var form=document.querySelector('dialog form');form.origin.value='accounts-fixture.test';form.label.value=${JSON.stringify(label)};form.username.value=${JSON.stringify(email)};form.password.value='testSecret-34';form.requestSubmit();`,
    );
    await until(async () => !(await has("dialog")), "entry saved");
  }
  await add("Personal", "p@accounts-fixture.test");
  await add("Work", "w@accounts-fixture.test");
  assert.equal(
    await ev(vault, "document.querySelectorAll('.items .row').length"),
    2,
  );
  const storage = await ev(vault, "chrome.storage.local.get(null)");
  assert(!JSON.stringify(storage).includes("testSecret"));
  assert(!JSON.stringify(storage).includes("accounts-fixture.test"));
  await ev(
    vault,
    "document.querySelector('#search').value='Personal';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('[data-act=reveal]').click()",
  );
  await until(
    () =>
      ev(
        vault,
        "document.querySelector('#secret')?.textContent==='testSecret-34'",
      ),
    "reveal",
  );
  await ev(vault, "document.querySelector('[data-act=lock]').click()");
  await until(() => has("#auth"), "locked");
  assert(
    !(await ev(vault, "document.body.innerText")).includes(
      "accounts-fixture.test",
    ),
  );
  await ev(
    vault,
    "document.querySelector('#auth').password.value='invalid';document.querySelector('#auth').requestSubmit()",
  );
  await until(
    () =>
      ev(
        vault,
        "document.querySelector('.err')?.textContent.includes('Could not unlock')",
      ),
    "wrong password",
  );
  await ev(
    vault,
    "document.querySelector('#auth').password.value='example test 4921';document.querySelector('#auth').requestSubmit()",
  );
  await until(() => has(".columns"), "unlocked again");
  assert.equal(
    await ev(vault, "document.querySelectorAll('.items .row').length"),
    2,
  );
  console.log(
    "Brave passed: setup, encrypted storage, duplicate-site accounts, search, reveal, lock, wrong-password rejection, unlock.",
  );
  // Intercept every fixture request before navigating to its HTTPS origin.
  const siteTarget = (await cmd("Target.createTarget", { url: "about:blank" }))
    .targetId;
  const siteSession = await attach(siteTarget);
  let fixture = "password";
  const recordSubmission =
    'onsubmit="event.preventDefault(); window.submitted=new FormData(this); window.submissionCount=(window.submissionCount || 0)+1"';
  const passwordFields =
    '<input name="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button>';
  const pages = {
    password:
      '<form method="post" ' +
      recordSubmission +
      ">" +
      passwordFields +
      "</form>",
    signed:
      '<button aria-label="Open account menu" onclick="document.querySelector(\'section\').hidden=false">Profile</button><section hidden role="menu">personal@example.net<button onclick="location.href=\'/login\'">Log out</button></section>',
    email:
      '<form method="post" ' +
      recordSubmission +
      '><input type="email" name="email"><button>Continue with Email</button></form>',
  };
  client.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Fetch.requestPaused" && m.sessionId === siteSession) {
      const url = new URL(m.params.request.url);
      let html = pages[fixture];
      if (fixture === "signed" && url.pathname === "/login")
        html =
          '<form method="post" action="/session">' + passwordFields + "</form>";
      if (fixture === "signed" && url.pathname === "/session") {
        const values = new URLSearchParams(m.params.request.postData);
        const username = values.get("username");
        const accepted =
          m.params.request.method === "POST" &&
          ((username === "work@example.net" &&
            values.get("password") === "fixture-work") ||
            (username === "personal@example.net" &&
              values.get("password") === "fixture-personal"));
        html = accepted
          ? `<section role="menu">${username}<button onclick="location.href='/login'">Sign out</button></section>`
          : "<p>Sign-in rejected</p>";
      }
      cmd(
        "Fetch.fulfillRequest",
        {
          requestId: m.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from(html).toString("base64"),
        },
        siteSession,
      ).catch(() => {});
    }
  });
  await cmd("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, siteSession);
  async function visit(url) {
    await cmd("Page.navigate", { url }, siteSession);
    await until(
      () =>
        ev(
          siteSession,
          "location.href === " +
            JSON.stringify(url) +
            ' && document.readyState==="complete"',
        ),
      "fixture loaded",
    );
  }
  const service = await attach(sw.targetId);
  async function grantAction() {
    await cmd("Target.activateTarget", { targetId: siteTarget });
    const tabs = (await cmd("Target.getTargets", { filter: [{ type: "tab" }] }))
      .targetInfos;
    const url = await ev(siteSession, "location.href");
    const target = tabs.find((t) => t.url === url);
    assert(target, "tab found " + JSON.stringify(tabs));
    await cmd("Extensions.triggerAction", { id, targetId: target.targetId });
    await sleep(300);
  }
  const rpc = (type, data = {}) =>
    ev(
      vault,
      `chrome.runtime.sendMessage(${JSON.stringify({ type, ...data })}).then(reply=>{if(reply.error)throw Error(reply.error);return reply.value})`,
    );
  async function submitLogin(username, password) {
    await ev(
      siteSession,
      `var form=document.forms[0];form.username.value=${JSON.stringify(username)};document.querySelector('[type=password]').value=${JSON.stringify(password)};form.requestSubmit();`,
    );
  }
  async function findPicker() {
    return (await cmd("Target.getTargets")).targetInfos.find((target) =>
      target.url.endsWith("/popup.html"),
    );
  }
  async function closePicker() {
    const popup = await findPicker();
    if (popup)
      await ev(
        await attach(popup.targetId),
        "setTimeout(() => window.close(), 0)",
      );
    await until(async () => !(await findPicker()), "picker closes");
  }
  async function clickSiteButton(selector) {
    const point = await ev(
      siteSession,
      `{
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      ({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
    }`,
    );
    await cmd(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...point },
      siteSession,
    );
    await cmd(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...point },
      siteSession,
    );
  }
  await visit("https://accounts-fixture.test/login");
  await sleep(150);
  await submitLogin("new@accounts-fixture.test", "sample-password-v1");
  await until(findPicker, "save offer automatically opens the picker");
  const automaticPicker = await attach((await findPicker()).targetId);
  await until(
    () =>
      ev(
        automaticPicker,
        "document.querySelector('.pending')?.innerText.includes('new@accounts-fixture.test') && !document.querySelector('#startup')",
      ),
    "automatic offer displays after loading",
  );
  await closePicker();
  await grantAction();
  const tabId = await ev(
    service,
    "chrome.tabs.query({}).then(ts=>ts.find(t=>t.url?.startsWith('https://accounts-fixture.test')).id)",
  );
  const records = await rpc("list");
  const pickerTarget = (await cmd("Target.getTargets")).targetInfos.find(
    (target) => target.url.endsWith("/popup.html"),
  );
  assert(pickerTarget, "toolbar opened the picker");
  const picker = await attach(pickerTarget.targetId);
  await until(
    () =>
      ev(picker, 'document.querySelectorAll("[data-act=switch]").length===2'),
    "picker shows both site accounts",
  );
  await until(
    () =>
      ev(
        picker,
        "document.querySelector('[data-act=prompts]')?.textContent.startsWith('Disable')",
      ),
    "save prompts enabled by default",
  );
  const context = { tab: tabId, origin: "https://accounts-fixture.test" };
  await until(
    async () =>
      (await rpc("draft", context))?.username === "new@accounts-fixture.test",
    "save offer before opening the picker or enabling permission per site",
  );
  assert.equal((await rpc("list")).length, 2, "save requires confirmation");
  const helpPoint = await ev(
    picker,
    `{
      const rect = document.querySelector('[aria-describedby=save-prompts-help]').getBoundingClientRect();
      ({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
    }`,
  );
  await cmd(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...helpPoint },
    picker,
  );
  await until(
    () =>
      ev(
        picker,
        "getComputedStyle(document.querySelector('[role=tooltip]')).opacity === '1'",
      ),
    "tooltip appears on hover",
  );
  await cmd(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: 4, y: 4 },
    picker,
  );
  await until(
    () =>
      ev(
        picker,
        "getComputedStyle(document.querySelector('[role=tooltip]')).opacity === '0'",
      ),
    "tooltip hides after hover",
  );
  await ev(
    picker,
    "document.querySelector('[aria-describedby=save-prompts-help]').focus()",
  );
  await until(
    () =>
      ev(
        picker,
        "getComputedStyle(document.querySelector('[role=tooltip]')).opacity === '1'",
      ),
    "tooltip appears on keyboard focus",
  );
  await ev(
    picker,
    "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))",
  );
  await until(
    () =>
      ev(
        picker,
        "getComputedStyle(document.querySelector('[role=tooltip]')).opacity === '0'",
      ),
    "tooltip can be dismissed",
  );
  await ev(
    picker,
    '[...document.querySelectorAll("[data-act=switch]")].find(el=>el.innerText.includes("Work")).click()',
  );
  await until(
    () =>
      ev(
        siteSession,
        'window.submitted?.get("username")==="w@accounts-fixture.test" && window.submitted?.get("password")==="testSecret-34"',
      ),
    "one toolbar click submits the chosen login",
  );
  assert.equal(
    await ev(siteSession, "document.forms[0].username.value"),
    "w@accounts-fixture.test",
  );
  assert.equal(
    await ev(siteSession, 'document.querySelector("[type=password]").value'),
    "testSecret-34",
  );
  await assert.rejects(() =>
    rpc("switch", {
      origin: "https://elsewhere.test",
      tab: tabId,
      id: records[0].id,
    }),
  );
  console.log(
    "Brave passed: one-click login, active-tab grant, and foreign-origin rejection.",
  );
  await rpc("dismiss", context);
  assert.equal(await rpc("draft", context), null);
  await submitLogin("w@accounts-fixture.test", "sample-password-v2");
  await until(
    async () =>
      (await rpc("draft", context))?.password === "sample-password-v2",
    "changed password offer",
  );
  const review = await page(
    "chrome-extension://" + id + "/vault.html?add=1&tab=" + tabId,
  );
  await until(
    () => ev(review, "!!document.querySelector('dialog form')"),
    "review form",
  );
  assert.equal(
    await ev(review, "document.querySelector('dialog form').password.value"),
    "sample-password-v2",
  );
  await ev(review, "document.querySelector('dialog form').requestSubmit()");
  await until(
    async () =>
      (await rpc("detail", { id: records.find((e) => e.label === "Work").id }))
        .password === "sample-password-v2",
    "save update",
  );
  assert.equal((await rpc("list")).length, 2, "update within matching account");
  await submitLogin("new@accounts-fixture.test", "sample-password-v1");
  await until(
    async () => !!(await rpc("draft", context)),
    "pending save offer",
  );
  await rpc("prompts", { ...context, enable: false });
  assert.equal((await rpc("site", context)).enabled, false, "prompts disabled");
  assert.equal(
    (await rpc("site", { origin: "https://elsewhere.test" })).enabled,
    true,
  );
  assert.equal(
    await rpc("draft", context),
    null,
    "disabling clears pending login",
  );
  await visit(context.origin + "/login?reload");
  await submitLogin("new@accounts-fixture.test", "sample-password-v1");
  await sleep(200);
  assert.equal(
    await rpc("draft", context),
    null,
    "prompts stay off after navigation",
  );
  await rpc("prompts", { ...context, enable: true });
  await sleep(100);
  await submitLogin("new@accounts-fixture.test", "sample-password-v1");
  await until(
    async () => !!(await rpc("draft", context)),
    "re-enabled prompts work",
  );
  await rpc("dismiss", context);
  await closePicker();
  console.log(
    "Brave passed: automatic save prompts, tooltip, confirmed updates, and per-site controls.",
  );
  const signedIn =
    "<header>provider-account@example.test <button>Sign out</button></header>";
  for (const [method, provider] of [
    ["Provider", "Google"],
    ["Passkey", ""],
    ["Email", ""],
  ]) {
    await cmd("Target.activateTarget", { targetId: siteTarget });
    fixture = method === "Email" ? "email" : "delegated";
    pages.delegated =
      '<button id="sign-in">' +
      (provider ? "Continue with " + provider : "Sign in with a passkey") +
      "</button>";
    await visit(context.origin + "/login?flow=" + method);
    await sleep(150);
    if (method === "Email")
      await ev(
        siteSession,
        `{
      const form = document.forms[0];
      form.addEventListener("submit", event => event.preventDefault());
      form.email.value = "email-account@example.test";
      form.requestSubmit();
    }`,
      );
    else await clickSiteButton("#sign-in");
    await sleep(650);
    assert.equal(
      await rpc("draft", context),
      null,
      "wait for sign-in confirmation",
    );

    if (provider) {
      fixture = "password";
      await visit("https://identity-fixture.test/auth");
      await submitLogin(
        "provider-account@example.test",
        "fixture-provider-password",
      );
      assert.equal(
        await rpc("draft", {
          tab: tabId,
          origin: "https://identity-fixture.test",
        }),
        null,
      );
      pages.authenticated = signedIn;
      fixture = "authenticated";
      await visit(context.origin + "/dashboard");
    } else {
      await ev(
        siteSession,
        "document.body.innerHTML=" + JSON.stringify(signedIn),
      );
    }
    await until(
      async () => (await rpc("draft", context))?.method === method,
      method + " save offer",
    );
    const offer = await rpc("draft", context);
    assert.equal(offer.provider, provider);
    assert.equal(offer.password, "");
    assert.equal(
      offer.username,
      method === "Email"
        ? "email-account@example.test"
        : "provider-account@example.test",
    );
    await until(findPicker, method + " opens the picker");
    if (provider) {
      const popup = await attach((await findPicker()).targetId);
      await until(
        () =>
          ev(
            popup,
            "document.querySelector('[data-act=review]') && !document.querySelector('#startup')",
          ),
        "provider review button",
      );
      const existing = new Set(
        (await cmd("Target.getTargets")).targetInfos.map((t) => t.targetId),
      );
      await ev(popup, "document.querySelector('[data-act=review]').click()");
      let reviewTab;
      await until(async () => {
        reviewTab = (await cmd("Target.getTargets")).targetInfos.find(
          (t) =>
            !existing.has(t.targetId) &&
            t.url.startsWith("chrome-extension://" + id + "/vault.html"),
        );
        return !!reviewTab;
      }, "automatic offer opens review");
      const reviewSession = await attach(reviewTab.targetId);
      await until(
        () =>
          ev(
            reviewSession,
            "document.querySelector('dialog form')?.elements.provider.value === 'Google'",
          ),
        "review remembers provider",
      );
      // The review belongs to the offer even if the site redirects afterward.
      await visit("https://elsewhere-fixture.test/after-login");
      await until(
        async () => !(await rpc("draft", context)),
        "redirect detaches the tab notification",
      );
      await until(
        async () =>
          !(
            await rpc("site", {
              tab: tabId,
              origin: "https://elsewhere-fixture.test",
            })
          ).pending,
        "unrelated site does not inherit the offer",
      );
      await ev(
        reviewSession,
        "document.querySelector('dialog form').requestSubmit()",
      );
      await until(
        async () => (await rpc("list")).some((e) => e.provider === "Google"),
        "provider saves after confirmation",
      );
      const saved = (await rpc("list")).find((e) => e.provider === "Google");
      assert.equal(saved.hasPassword, false);
      await rpc("delete", { id: saved.id });
      await cmd("Target.closeTarget", { targetId: reviewTab.targetId });
      await cmd("Target.activateTarget", { targetId: siteTarget });
    } else {
      await rpc("dismiss", context);
    }
    await closePicker();
  }
  console.log(
    "Brave passed: provider redirect, passkey and email offers, and passwordless review.",
  );
  const savedWork = records.find((e) => e.label === "Work").id;
  fixture = "password";
  await visit(context.origin + "/login?get-form");
  await ev(siteSession, "document.forms[0].method='get'");
  await grantAction();
  await rpc("switch", { ...context, id: savedWork });
  assert.equal(
    await ev(siteSession, "document.forms[0].password.value"),
    "sample-password-v2",
  );
  assert.equal(
    await ev(siteSession, "window.submissionCount || 0"),
    0,
    "password forms using GET require manual submission",
  );
  await closePicker();

  await visit(context.origin + "/login?manual-submit");
  await ev(
    siteSession,
    "document.querySelector('button').textContent='Confirm password'",
  );
  await grantAction();
  await rpc("switch", { ...context, id: savedWork });
  assert.equal(
    await ev(siteSession, "window.submissionCount || 0"),
    0,
    "unrecognized buttons are left for manual submission",
  );
  await closePicker();

  await visit(context.origin + "/login?other-account");
  await ev(
    siteSession,
    "Object.assign(document.forms[0].username,{type:'hidden',value:'other@example.test'})",
  );
  await grantAction();
  await rpc("switch", { ...context, id: savedWork });
  assert.equal(
    await ev(siteSession, "document.forms[0].password.value"),
    "",
    "credentials stay out of another account's form",
  );
  await closePicker();

  fixture = "email";
  await visit(context.origin + "/login");
  await grantAction();
  await rpc("switch", {
    ...context,
    id: savedWork,
  });
  assert.equal(
    await ev(siteSession, "window.submitted?.get('email')"),
    "w@accounts-fixture.test",
  );
  await ev(
    siteSession,
    `document.forms[0].innerHTML='<input type="password" autocomplete="one-time-code"><button>Continue</button>';document.body.insertAdjacentHTML('beforeend','<a href="/login?restart">Sign in</a>')`,
  );
  await sleep(1300);
  assert.equal(
    await ev(siteSession, "location.search"),
    "",
    "verification stays on the current page",
  );
  assert.equal(
    await ev(siteSession, "document.querySelector('input').value"),
    "",
    "verification code field remains empty",
  );
  assert.equal(await ev(siteSession, "window.submissionCount"), 1);
  await ev(
    siteSession,
    `document.forms[0].innerHTML='<input name="password" type="password" autocomplete="current-password"><button>Sign in</button>'`,
  );
  await until(
    () =>
      ev(
        siteSession,
        "window.submitted?.get('password')==='sample-password-v2' && window.submissionCount===2",
      ),
    "second login step submits updated password",
  );
  console.log(
    "Brave passed: multi-step login and verification-code exclusion.",
  );
  const switchOrigin = "https://switch-fixture.test";
  const workId = await rpc("save", {
    origin: switchOrigin,
    username: "work@example.net",
    label: "Work",
    password: "fixture-work",
    method: "Password",
  });
  const personalId = await rpc("save", {
    origin: switchOrigin,
    username: "personal@example.net",
    label: "Personal",
    password: "fixture-personal",
    method: "Password",
  });
  for (const [which, email] of [
    [workId, "work@example.net"],
    [personalId, "personal@example.net"],
  ]) {
    fixture = "signed";
    await visit(switchOrigin + "/dashboard");
    if (which === personalId)
      await ev(
        siteSession,
        'document.querySelector("section").firstChild.textContent="work@example.net"',
      );
    await grantAction();
    await rpc("switch", { origin: switchOrigin, tab: tabId, id: which });
    await until(
      () =>
        ev(
          siteSession,
          'location.pathname==="/session" && document.querySelector("section")?.firstChild.textContent===' +
            JSON.stringify(email),
        ),
      "sign-out followed by sign-in as the selected account",
    );
  }
  console.log(
    "Brave passed: two-way sign-out and automatic sign-in against intercepted fixture pages.",
  );
  await ev(service, "chrome.storage.session.set({deadline:Date.now()-1})");
  assert.equal(
    (await rpc("status")).unlocked,
    false,
    "expired vault is locked",
  );
  assert.deepEqual(
    await ev(service, "chrome.storage.session.get(null)"),
    {},
    "expired secrets are cleared",
  );
  console.log("Brave passed: inactivity expiry clears the session.");
  await rpc("unlock", { password: "example test 4921" });
  await until(() => has("[data-act=settings]"), "unlocked Settings navigation");
  await ev(vault, "document.querySelector('[data-act=settings]').click()");
  await ev(vault, "document.querySelector('[data-act=protection]').click()");
  const submitProtection = (password) =>
    ev(
      vault,
      `{
    const form = document.querySelector('dialog form');
    form.password.value = ${JSON.stringify(password)};
    if (form.confirm) form.confirm.value = form.password.value;
    form.requestSubmit();
  }`,
    );
  await submitProtection("invalid");
  await until(
    () =>
      ev(
        vault,
        "document.querySelector('dialog .err')?.textContent.includes('Could not unlock')",
      ),
    "current password required to remove protection",
  );
  await submitProtection("example test 4921");
  await until(
    () =>
      ev(
        vault,
        "document.querySelector('[data-act=protection]')?.textContent.includes('Set master password')",
      ),
    "master password removed",
  );
  const deviceVault = await page("chrome-extension://" + id + "/vault.html");
  await until(
    () =>
      ev(deviceVault, "document.querySelectorAll('.items .row').length===4"),
    "existing accounts open without a master password",
  );
  assert.equal(
    await ev(deviceVault, "!!document.querySelector('[data-act=lock]')"),
    false,
  );
  assert.equal((await rpc("list")).length, 4);
  const work = records.find((e) => e.label === "Work");
  assert.equal(
    (await rpc("detail", { id: work.id })).password,
    "sample-password-v2",
  );
  await ev(vault, "document.querySelector('[data-act=protection]').click()");
  await submitProtection("example test 4921");
  await until(
    () =>
      ev(
        vault,
        "document.querySelector('[data-act=protection]')?.textContent.includes('Remove master password')",
      ),
    "master password restored",
  );
  assert.equal(
    await ev(
      vault,
      "chrome.storage.local.get('vault').then(r=>!!r.vault.deviceKey)",
    ),
    false,
  );
  console.log(
    "Brave passed: Settings protects and unprotects existing accounts.",
  );
  await restart();
}
run(undefined, process.argv.includes("--device-setup"))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    client?.close();
    if (brave.exitCode === null) {
      await Promise.race([
        new Promise((r) => brave.once("exit", r)),
        sleep(1000),
      ]);
      if (brave.exitCode === null) brave.kill();
    }
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 150,
    });
  });
