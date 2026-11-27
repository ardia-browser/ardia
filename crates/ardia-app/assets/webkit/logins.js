(() => {
  if (window.__ardiaLogins) return;
  const post = (kind, data) => {
    try {
      window.webkit.messageHandlers.ardia.postMessage({ kind, data, frame: "logins" });
    } catch (e) {}
  };
  const visible = (el) => !!el && !el.disabled && !el.readOnly && el.getClientRects().length > 0;
  const passwordIn = (root) => Array.from((root || document).querySelectorAll("input[type=password]")).find(visible) || null;
  const usernameFor = (password) => {
    const scope = password.form || document;
    const fields = Array.from(scope.querySelectorAll("input")).filter((el) => visible(el) && /^(text|email|tel|)$/i.test(el.type || "text"));
    const before = fields.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.pop() || fields.find((el) => /user|mail|login|account/i.test(el.name + el.id + el.autocomplete)) || null;
  };
  const loginField = (el) => {
    if (!el || el.tagName !== "INPUT" || !visible(el)) return null;
    if (el.type === "password") return { password: el, username: usernameFor(el) };
    const password = passwordIn(el.form || document);
    if (!password) return null;
    const username = usernameFor(password);
    return username === el ? { password, username } : null;
  };
  let active = null;
  let open = false;
  let picking = false;
  const hide = () => {
    if (open) post("loginField", { event: "hide" });
  };
  const report = (event, el) => {
    const found = loginField(el);
    if (!found) return hide();
    active = { el, found };
    const r = el.getBoundingClientRect();
    const isPassword = el.type === "password";
    post("loginField", {
      event, origin: location.origin, password: isPassword, value: isPassword ? "" : String(el.value || "").slice(0, 200),
      x: r.left, y: r.top, width: r.width, height: r.height,
    });
  };
  addEventListener("pointerdown", (e) => {
    if (e.isTrusted) report("show", e.target);
  }, true);
  addEventListener("input", (e) => {
    const el = e.target;
    if (!e.isTrusted || !el || el.tagName !== "INPUT") return;
    if (el.type === "password") return hide();
    if (loginField(el)) report("input", el);
  }, true);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || !active || e.target !== active.el) return;
    const key = { ArrowDown: "down", ArrowUp: "up", Enter: "enter", Escape: "escape", Tab: "tab" }[e.key];
    if (!key) return;
    if (!open) {
      if (key === "down") {
        e.preventDefault();
        report("show", e.target);
      }
      return;
    }
    if (key !== "tab" && (key !== "enter" || picking)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    post("loginField", { event: "key", key });
  }, true);
  addEventListener("focusout", (e) => {
    if (active && e.target === active.el) hide();
  }, true);
  addEventListener("scroll", hide, true);
  addEventListener("resize", hide);
  addEventListener("pagehide", hide);
  const submitted = (form) => {
    const password = passwordIn(form);
    if (!password || !password.value) return;
    const username = usernameFor(password);
    const field = { name: password.getAttribute("name") || "", id: password.id || "", autocomplete: password.getAttribute("autocomplete") || "" };
    post("loginSubmit", { username: username ? username.value : "", password: password.value, origin: location.origin, field });
  };
  addEventListener("submit", (e) => submitted(e.target), true);
  addEventListener("click", (e) => {
    const button = e.target && e.target.closest && e.target.closest("button, input[type=submit]");
    if (button && e.isTrusted) submitted(button.form || document);
  }, true);
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.__ardiaLogins = {
    dropdown(isOpen, hasPick) {
      open = !!isOpen;
      picking = !!hasPick;
    },
    formShown(origin, field) {
      if (location.origin !== origin) return false;
      const same = (el) => (el.getAttribute("name") || "") === field.name && (el.id || "") === field.id && (el.getAttribute("autocomplete") || "") === field.autocomplete;
      return Array.from(document.querySelectorAll("input[type=password]")).some((el) => visible(el) && same(el));
    },
    fill(username, password, origin) {
      if (location.origin !== origin) return false;
      const target = active && active.el.isConnected && active.found.password.isConnected ? active.found : null;
      const field = target ? target.password : passwordIn(document);
      if (!field) return false;
      const user = target ? target.username : usernameFor(field);
      if (user && username) setValue(user, username);
      setValue(field, password);
      open = picking = false;
      return true;
    },
  };
})();
