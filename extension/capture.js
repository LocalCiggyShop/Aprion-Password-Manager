(() => {
  if (globalThis.aprionSaveListener || top !== window) return;
  globalThis.aprionSaveListener = true;
  let enabled = false;
  let toast, timer;
  function showOffer() {
    if (!enabled || !document.documentElement) return;
    toast?.remove();
    toast = document.createElement("div");
    const shadow = toast.attachShadow({ mode: "closed" });
    const text = document.createElement("div");
    text.setAttribute("role", "status");
    text.textContent =
      "Save this login? Open Aprion in your toolbar to review it.";
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
    clearTimeout(timer);
    timer = setTimeout(() => toast?.remove(), 9000);
  }
  async function refresh() {
    enabled = false;
    const reply = await chrome.runtime
      .sendMessage({ type: "canCapture" })
      .catch(() => null);
    enabled = !!reply?.value?.enabled;
    if (reply?.value?.pending) showOffer();
    else toast?.remove();
  }
  refresh();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "refreshCapture") refresh();
  });
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (
        !enabled ||
        !event.isTrusted ||
        !(form instanceof HTMLFormElement) ||
        new URL(form.action).origin !== location.origin
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
      const pw =
        fields.find(
          (el) => el.type === "password" && el.autocomplete === "new-password",
        ) || fields.find((el) => el.type === "password");
      const emailLogin =
        !pw &&
        user?.value &&
        (/\/(login|signin|sign-in|signup|sign-up|register)(\/|$)/i.test(
          location.pathname,
        ) ||
          /sign in|log in|continue with email|sign up|create account/i.test(
            form.innerText,
          ));
      if (emailLogin)
        chrome.runtime
          .sendMessage({ type: "identity", username: user.value })
          .catch(() => {});
      if (!pw?.value && !emailLogin) {
        return;
      }
      chrome.runtime
        .sendMessage({
          type: "capture",
          username: user?.value || "",
          password: pw?.value || "",
        })
        .then((reply) => {
          if (reply?.value) showOffer();
        })
        .catch(() => {});
    },
    true,
  );
})();
