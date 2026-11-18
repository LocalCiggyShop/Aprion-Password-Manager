// Injected into the browser's isolated world. Recheck the live page, including
// the form destination, even when the worker has already inspected this document.
export function interactWithSite(origin, request) {
  if (location.origin !== origin || window !== top) return {};
  const visible = (el) =>
    el.getClientRects().length &&
    getComputedStyle(el).visibility !== "hidden" &&
    !el.disabled;
  const named = (el, pattern) =>
    [el.innerText, el.getAttribute("aria-label"), el.title, el.value].some(
      (name) => typeof name === "string" && pattern.test(name.trim()),
    );
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
    return { signedIn: true, email: emails.length === 1 ? emails[0] : null };
  }
  if (request.action === "logout") return {};
  const loginForms = [];
  for (const form of document.forms) {
    const safeDestination = () => {
      const buttons = [...form.elements].filter((el) =>
        el.hasAttribute("formaction"),
      );
      return (
        new URL(form.action, location.href).origin === origin &&
        buttons.every((el) => new URL(el.formAction).origin === origin)
      );
    };
    if (!safeDestination()) continue;
    const inputs = [...form.elements].filter(
      (el) => el instanceof HTMLInputElement && visible(el) && !el.readOnly,
    );
    if (
      inputs.some((el) =>
        /new-password|one-time-code|otp|verification.?code/i.test(
          [el.autocomplete, el.name, el.id].join(" "),
        ),
      )
    )
      continue;
    const username = inputs.find(
      (el) =>
        ["text", "email", "tel"].includes(el.type) &&
        (el.autocomplete === "username" ||
          el.type === "email" ||
          /^(email|username|login)$/i.test(el.name)),
    );
    const password = inputs.find((el) => el.type === "password");
    if (!username && !password) continue;
    const buttons = controls.filter(
      (el) => el.form === form && el.type === "submit",
    );
    if (
      buttons.some((el) =>
        named(el, /create account|sign\s?up|register|reset password/i),
      )
    )
      continue;
    const signIn = buttons.some((el) =>
      named(
        el,
        /^(log\s?in|sign\s?in|continue|next)( with (email|password))?$/i,
      ),
    );
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
    if (request.action !== "fill") return { login: true };
    const { form, username, password, safeDestination } = loginForms[0];
    const { entry, stage } = request;
    if (
      stage === "password" &&
      username?.value &&
      username.value !== entry.username
    )
      return {};
    function write(input, value) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (username && stage !== "password") write(username, entry.username);
    if (
      password &&
      entry.password &&
      password.isConnected &&
      password.form === form &&
      safeDestination()
    ) {
      write(password, entry.password);
      return { stage: "done" };
    }
    if (username && stage !== "password")
      return { stage: entry.password ? "password" : "done" };
    return {};
  }
  if (request.action === "fill") return {};
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
  if (globalThis.aprionSwitchTimer) return;
  let remaining = 120;
  globalThis.aprionSwitchTimer = setInterval(async () => {
    let active;
    try {
      active = (await chrome.runtime.sendMessage({ type: "advance" }))?.value;
    } catch {}
    if (!active || !--remaining) {
      clearInterval(globalThis.aprionSwitchTimer);
      delete globalThis.aprionSwitchTimer;
    }
  }, 1000);
}
