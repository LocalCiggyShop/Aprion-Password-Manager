// Injected into the browser's isolated world. Recheck the live page, including
// the form destination, even when the worker has already inspected this document.
export function interactWithSite(origin, request) {
  if (location.origin !== origin || window !== top) return {};
  // Keep the second call bound to the inspected document on browsers that
  // cannot target a document ID with scripting.executeScript.
  const documentToken = (globalThis.aprionDocumentToken ??=
    crypto.randomUUID());
  if (request.action && documentToken !== request.documentToken) return {};
  const visible = (el) =>
    el.getClientRects().length &&
    getComputedStyle(el).visibility !== "hidden" &&
    !el.matches(":disabled");
  const named = (el, pattern) =>
    [el.innerText, el.getAttribute("aria-label"), el.title, el.value].some(
      (name) => typeof name === "string" && pattern.test(name.trim()),
    );
  const signInLabel =
    /^(log\s?in|sign\s?in|continue|next)( with (email|password))?$/i;
  const otherFlow =
    /(?:create|delete|remove) (?:an? |your )?account|sign\s?up|register|(?:change|reset|update) (?:your )?password/i;
  const userField = (el) =>
    ["text", "email", "tel", "hidden"].includes(el.type) &&
    (el.autocomplete === "username" ||
      el.type === "email" ||
      /^(email|username|login)$/i.test(el.name));
  function submitLogin(form, safeDestination, password) {
    const submitters = [...form.elements].filter(
      (el) => el.type === "submit" && visible(el),
    );
    const recognized = submitters.filter((el) => named(el, signInLabel));
    if (!form.isConnected || recognized.length !== 1) return false;
    const [submitter] = recognized;
    const canSubmit = (button) => {
      const method = (
        button.getAttribute("formmethod") ??
        form.getAttribute("method") ??
        "get"
      ).toLowerCase();
      const target =
        button.getAttribute("formtarget") ||
        form.getAttribute("target") ||
        document.querySelector("base[target]")?.target;
      // A native GET would put the filled password in the address bar.
      return (
        safeDestination() &&
        (method === "post" || (!password && method === "get")) &&
        (!target || target.toLowerCase() === "_self")
      );
    };
    if (!canSubmit(submitter)) return false;
    let submitted = false;
    const checkSubmission = (event) => {
      if (event.target !== form) return;
      if (event.submitter !== submitter || !canSubmit(submitter)) {
        event.preventDefault();
        return;
      }
      submitted = true;
    };
    window.addEventListener("submit", checkSubmission, true);
    try {
      submitter.click();
    } finally {
      window.removeEventListener("submit", checkSubmission, true);
    }
    return submitted;
  }
  const controls = [
    ...document.querySelectorAll(
      'button,a[href],[role="button"],[role="menuitem"],input[type="submit"]',
    ),
  ].filter(visible);
  const exit = controls.find((el) => named(el, /^(log\s?out|sign\s?out)$/i));
  if (exit) {
    if (request.action === "logout") {
      exit.click();
      return { logout: true };
    }
    const menu = exit.closest('[role="menu"],[role="dialog"]');
    const emails = [
      ...new Set(menu?.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []),
    ];
    return {
      signedIn: true,
      email: emails.length === 1 ? emails[0] : null,
      documentToken,
    };
  }
  if (request.action === "logout") return {};
  const loginForms = [];
  let verification = false;
  for (const form of document.forms) {
    const safeDestination = () => {
      const buttons = [...form.elements].filter((el) =>
        el.hasAttribute("formaction"),
      );
      return (
        new URL(form.getAttribute("action") || location.href, document.baseURI)
          .origin === origin &&
        buttons.every((el) => new URL(el.formAction).origin === origin)
      );
    };
    const inputs = [...form.elements].filter(
      (el) => el instanceof HTMLInputElement && visible(el) && !el.readOnly,
    );
    if (
      inputs.some((el) =>
        /one-time-code|otp|verification.?code/i.test(
          [el.autocomplete, el.name, el.id].join(" "),
        ),
      )
    ) {
      verification = true;
      continue;
    }
    if (
      !safeDestination() ||
      inputs.some((el) => el.autocomplete.split(/\s+/).includes("new-password"))
    )
      continue;
    const username = inputs.find(userField);
    const passwordFields = inputs.filter((el) => el.type === "password");
    if (passwordFields.length > 1) continue;
    const [password] = passwordFields;
    if (!username && !password) continue;
    const buttons = controls.filter(
      (el) => el.form === form && el.type === "submit",
    );
    if (buttons.some((el) => named(el, otherFlow))) continue;
    const signIn = buttons.some((el) => named(el, signInLabel));
    if (
      !signIn &&
      password?.autocomplete !== "current-password" &&
      !(
        /\/(login|signin|sign-in)(\/|$)/i.test(location.pathname) &&
        username?.autocomplete === "username"
      )
    )
      continue;
    loginForms.push({ form, username, password, safeDestination });
  }
  if (loginForms.length === 1) {
    if (request.action !== "fill") return { login: true, documentToken };
    const { form, username, password, safeDestination } = loginForms[0];
    const { entry, stage } = request;
    const fixedUser = [...form.elements].find(
      (el) =>
        el instanceof HTMLInputElement &&
        !el.disabled &&
        userField(el) &&
        (el.type === "hidden" || (el.readOnly && visible(el))),
    );
    if (fixedUser?.value && fixedUser.value !== entry.username)
      return { wrongAccount: true };
    if (
      stage === "password" &&
      username?.value !== undefined &&
      username.value !== entry.username
    )
      return { wrongAccount: true };
    if (
      password &&
      entry.password &&
      !username &&
      !fixedUser?.value &&
      !request.usernameSubmitted
    )
      return { wrongAccount: true };
    function write(input, value) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (username && stage !== "password") {
      write(username, entry.username);
      if (
        !username.isConnected ||
        username.form !== form ||
        username.value !== entry.username
      )
        return {};
    }
    if (password) {
      if (
        !entry.password ||
        !password.isConnected ||
        password.form !== form ||
        !safeDestination()
      )
        return {};
      write(password, entry.password);
      const submitted =
        password.isConnected &&
        password.form === form &&
        password.value === entry.password &&
        (!username ||
          (username.isConnected && username.value === entry.username)) &&
        submitLogin(form, safeDestination, password);
      return { stage: "done", submitted };
    }
    if (username && stage !== "password")
      return {
        stage: entry.password ? "password" : "done",
        submitted: submitLogin(form, safeDestination),
      };
    return {};
  }
  if (request.action === "fill") return {};
  if (verification) return { verification: true };
  if (
    controls.some((el) =>
      named(
        el,
        /^(continue|sign in|log in) (with|using) .+|^(use|choose) (a |your )?passkey$/i,
      ),
    )
  ) {
    return { providerLogin: true };
  }
  const links = controls.filter(
    (el) =>
      el.tagName === "A" &&
      el.origin === origin &&
      named(el, /^(log\s?in|sign\s?in)$/i),
  );
  const destinations = [...new Set(links.map((el) => el.href))];
  if (destinations.length === 1) return { loginUrl: destinations[0] };
  if (request.openMenu) {
    const menus = controls.filter((el) =>
      named(
        el,
        /^(open |toggle |show )?(my |your )?(account|user|profile)( menu| options)?$/i,
      ),
    );
    if (menus.length === 1) {
      menus[0].click();
      return { opened: true };
    }
  }
  return {};
}

export function watchSwitch() {
  const browserAPI = globalThis.browser ?? globalThis.chrome;
  if (globalThis.aprionSwitchTimer) return;
  let remaining = 120;
  globalThis.aprionSwitchTimer = setInterval(async () => {
    let active;
    try {
      active = (await browserAPI.runtime.sendMessage({ type: "advance" }))
        ?.value;
    } catch {}
    if (!active || !--remaining) {
      clearInterval(globalThis.aprionSwitchTimer);
      delete globalThis.aprionSwitchTimer;
    }
  }, 1000);
}
