(() => {
  const browserAPI = globalThis.browser ?? globalThis.chrome;
  if (globalThis.aprionSaveListener || top !== window) return;
  globalThis.aprionSaveListener = true;
  let enabled = false;
  let toast, toastTimer, watchTimer;
  const authControls =
    'a[href], button, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"]';
  const names = (element) =>
    [
      element.getAttribute("aria-label"),
      element.innerText,
      element.title,
      element.value,
    ]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim().replace(/\s+/g, " "));

  function showOffer() {
    if (!enabled || !document.documentElement) return;
    toast?.remove();
    toast = document.createElement("div");
    const shadow = toast.attachShadow({ mode: "closed" });
    const text = document.createElement("div");
    text.setAttribute("role", "status");
    text.textContent =
      "Save this sign-in? Open Aprion in your toolbar to review it.";
    Object.assign(text.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      maxWidth: "300px",
      background: "#152b40",
      color: "#e9f3ff",
      padding: "14px 18px",
      border: "1px solid #34648e",
      borderRadius: "12px",
      font: "14px/1.5 system-ui",
    });
    shadow.append(text);
    document.documentElement.append(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast?.remove(), 9000);
  }

  function signedIn() {
    const visible = (element) =>
      element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible";
    const control = [...document.querySelectorAll(authControls)].find(
      (element) =>
        visible(element) &&
        names(element).some((name) => /^(sign ?out|log ?out)$/i.test(name)),
    );
    if (!control) return null;
    const account = control.closest(
      '[role="menu"], [role="dialog"], header, nav',
    );
    const emails = [
      ...new Set(
        account?.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || [],
      ),
    ];
    return { username: emails.length === 1 ? emails[0] : "" };
  }

  async function send(details) {
    const reply = await browserAPI.runtime
      .sendMessage(details)
      .catch(() => null);
    return reply?.value;
  }

  function watchSignIn() {
    clearInterval(watchTimer);
    const until = Date.now() + 120_000;
    watchTimer = setInterval(async () => {
      if (!enabled || Date.now() >= until) return clearInterval(watchTimer);
      const account = signedIn();
      if (!account) return;
      clearInterval(watchTimer);
      const offer = await send({
        type: "completed",
        username: account.username,
      });
      if (offer?.promptId) showOffer();
    }, 500);
  }

  async function remember(method, fields = {}) {
    const state = await send({ type: "attempt", method, ...fields });
    if (enabled && state?.watch) watchSignIn();
  }

  async function refresh() {
    enabled = false;
    clearInterval(watchTimer);
    const state = await send({ type: "canCapture" });
    enabled = !!state?.enabled;
    if (state?.pending) showOffer();
    else toast?.remove();
    if (state?.watch) watchSignIn();
  }

  refresh();
  browserAPI.runtime.onMessage.addListener((msg) => {
    if (msg.type === "refreshCapture") refresh();
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!enabled || !event.isTrusted) return;
      const control =
        event.target instanceof Element && event.target.closest(authControls);
      if (!control) return;
      for (const name of names(control)) {
        if (
          /^(?:(?:sign in|log in|continue) (?:with|using)|use) (?:a |your )?passkey$/i.test(
            name,
          )
        ) {
          if (!signedIn()) remember("Passkey");
          return;
        }
        const provider = name.match(
          /^(?:sign in|log in|sign up|continue) (?:with|using) (.{1,60})$/i,
        )?.[1];
        if (
          provider &&
          !/\b(email|e-mail|password|username|phone|code|passkey|link)\b/i.test(
            provider,
          )
        ) {
          if (!signedIn()) remember("Provider", { provider });
          return;
        }
      }
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (
        !enabled ||
        !event.isTrusted ||
        !(form instanceof HTMLFormElement) ||
        new URL(
          event.submitter?.hasAttribute("formaction")
            ? event.submitter.formAction
            : form.action,
          location.href,
        ).origin !== location.origin
      )
        return;
      const fields = [...form.querySelectorAll("input")].filter(
        (el) => !el.disabled,
      );
      if (
        fields.some((el) =>
          /one-time-code|otp|verification.?code/i.test(
            [el.autocomplete, el.name, el.id].join(" "),
          ),
        )
      )
        return;

      const user = fields.find(
        (el) =>
          el.autocomplete === "username" ||
          el.type === "email" ||
          /^(email|username|login)$/i.test(el.name),
      );
      const password =
        fields.find(
          (el) => el.type === "password" && el.autocomplete === "new-password",
        ) || fields.find((el) => el.type === "password");
      if (password?.value) {
        send({
          type: "capture",
          username: user?.value || "",
          password: password.value,
        }).then((offer) => {
          if (offer?.promptId) showOffer();
        });
        return;
      }
      if (
        !password &&
        user?.value &&
        (/\/(login|signin|sign-in|signup|sign-up|register)(\/|$)/i.test(
          location.pathname,
        ) ||
          /sign in|log in|continue with email|sign up|create account/i.test(
            form.innerText,
          )) &&
        !signedIn()
      )
        remember("Email", { username: user.value });
    },
    true,
  );
})();
