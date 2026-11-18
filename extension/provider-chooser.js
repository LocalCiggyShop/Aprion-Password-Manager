// Runs only in top-level documents on the provider hosts in the manifest.
(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const send = async (message) =>
    (await api.runtime.sendMessage(message).catch(() => null))?.value;
  const choice = await send({ type: "providerIdentity" });
  if (!choice || top !== window) return;
  const email = choice.username.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;

  const google = location.origin === "https://accounts.google.com";
  const interactive =
    '[role="link"],[role="button"],button,a[href],[tabindex="0"]';
  const visible = (el) =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility === "visible" &&
    !el.closest(
      '[inert],[aria-hidden="true"],[aria-disabled="true"],:disabled',
    );
  function matchingRow() {
    let rows;
    if (google) {
      if (
        !/\/(?:accountchooser|oauthchooseaccount)\/?$/i.test(location.pathname)
      )
        return;
      rows = [...document.querySelectorAll("[data-identifier],[data-email]")];
    } else {
      // Microsoft also serves consent and MFA at /authorize. Scope every row
      // to a native account picker, even when the page URL stays the same.
      const picker = document.querySelector(
        '#tilesHolder,#accountPicker,[data-testid="account-picker"]',
      );
      if (!picker || !visible(picker)) return;
      rows = [...picker.querySelectorAll(interactive)];
    }
    const matches = new Set();
    for (const row of rows) {
      const button = row.closest(interactive);
      if (!button || !visible(button) || !visible(row)) continue;
      const identity = [row.dataset.identifier, row.dataset.email].filter(
        Boolean,
      );
      if (!identity.length && !google)
        identity.push(
          ...(row.innerText.match(/[\w.!#$%&'*+\/=?^_`{|}~-]+@[\w.-]+/g) || []),
        );
      if (
        !identity.length ||
        !identity.every((value) => value.trim().toLowerCase() === email)
      )
        continue;
      // Ignore edit/remove controls inside account rows.
      if (
        button.getAttribute("aria-haspopup") ||
        /\b(?:remove|forget|sign out|delete|options)\b/i.test(
          [
            button.getAttribute("aria-label"),
            button.title,
            button.innerText,
          ].join(" "),
        )
      )
        continue;
      matches.add(button);
    }
    if (matches.size === 1) return [...matches][0];
  }

  let stopped = false;
  let claiming = false;
  const observer = new MutationObserver(check);
  const timer = setTimeout(stop, Math.max(0, choice.expires - Date.now()));
  function stop() {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", manual, true);
    window.removeEventListener("keydown", manual, true);
    window.removeEventListener("pagehide", stop);
  }
  function manual(event) {
    if (event.isTrusted) stop();
  }
  async function check() {
    if (stopped || claiming || Date.now() >= choice.expires) return;
    const row = matchingRow();
    if (!row) return;
    claiming = true;
    const authorized = await send({
      type: "providerPick",
      handoff: choice.handoff,
    });
    if (
      authorized &&
      !stopped &&
      matchingRow() === row &&
      Date.now() < choice.expires
    )
      row.click();
    stop();
  }
  window.addEventListener("pointerdown", manual, true);
  window.addEventListener("keydown", manual, true);
  window.addEventListener("pagehide", stop, { once: true });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  check();
})();
