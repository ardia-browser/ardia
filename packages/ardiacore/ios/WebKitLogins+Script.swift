import Foundation

extension WebKitLogins {
  static let script = #"""
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
  const NEW_PASSWORD = /(^|\s)new-password(\s|$)/i;
  const CURRENT_PASSWORD = /(^|\s)current-password(\s|$)/i;
  const newPasswordsIn = (root) => {
    const all = Array.from((root || document).querySelectorAll("input[type=password]")).filter(visible);
    const marked = all.filter((el) => NEW_PASSWORD.test(el.getAttribute("autocomplete") || ""));
    const unmarked = all.filter((el) => !CURRENT_PASSWORD.test(el.getAttribute("autocomplete") || ""));
    return marked.length ? marked : unmarked.length < all.length ? unmarked : all.length === 2 ? all : all.length === 3 ? all.slice(1) : [];
  };
  const newPasswords = (password) => {
    const found = newPasswordsIn(password.form);
    return found.includes(password) ? found : [];
  };
  const passwordRules = (fields) => {
    const limits = fields.map((f) => f.maxLength).filter((n) => n > 0);
    return { maxLength: limits.length ? Math.min(...limits) : 0, minLength: Math.max(0, ...fields.map((f) => f.minLength)) };
  };
  const ONE_TIME_CODE = /(^|\s)one-time-code(\s|$)/i;
  const OTHER_AUTOCOMPLETE = /(^|\s)(username|email|current-password|new-password|tel|postal-code|cc-[a-z-]+)(\s|$)/i;
  const CODE_HINT = /(^|[^a-z])(otp|totp|2fa|mfa)([^a-z]|$)|one.?time.?(pass)?code|verification.?code|verify.?code|security.?code|auth(entication)?.?code|passcode/i;
  const CODE_SHAPE = /^[A-Za-z0-9]{4,10}$/;
  const attribute = (el, name) => el.getAttribute(name) || "";
  const seen = (el) => visible(el) && (typeof el.checkVisibility !== "function" || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  const asksForCode = (el) => {
    const auto = attribute(el, "autocomplete");
    if (ONE_TIME_CODE.test(auto)) return true;
    return !OTHER_AUTOCOMPLETE.test(auto) && CODE_HINT.test([attribute(el, "name"), attribute(el, "id"), attribute(el, "placeholder"), attribute(el, "aria-label")].join(" "));
  };
  const codeField = (el) =>
    location.protocol === "https:" && !!el && el.tagName === "INPUT" && /^(text|tel|number|)$/i.test(attribute(el, "type")) && !el.value && seen(el) && asksForCode(el);
  let active = null;
  let open = false;
  let picking = false;
  const hide = () => {
    if (open) post("loginField", { event: "hide" });
  };
  const report = (event, el) => {
    const found = loginField(el);
    const code = !found && codeField(el);
    if (!found && !code) return hide();
    const isPassword = el.type === "password";
    const fresh = isPassword ? newPasswords(el) : [];
    active = { el, found, code, fresh };
    const r = el.getBoundingClientRect();
    post("loginField", {
      event, origin: location.origin, password: isPassword, code, newPassword: fresh.length > 0, ...(fresh.length ? passwordRules(fresh) : {}),
      value: isPassword || code ? "" : String(el.value || "").slice(0, 200),
      x: r.left, y: r.top, width: r.width, height: r.height,
    });
  };
  addEventListener("pointerdown", (e) => {
    if (e.isTrusted) report("show", e.target);
  }, true);
  addEventListener("input", (e) => {
    const el = e.target;
    if (!e.isTrusted || !el || el.tagName !== "INPUT") return;
    if (el.type === "password") {
      if (open) post("loginField", { event: "passwordInput", origin: location.origin });
      return;
    }
    if (loginField(el)) report("input", el);
    else if (active && active.code && el === active.el) hide();
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
    post("loginField", { event: "key", key, origin: location.origin });
  }, true);
  addEventListener("focusout", (e) => {
    if (active && e.target === active.el) hide();
  }, true);
  addEventListener("scroll", hide, true);
  addEventListener("resize", hide);
  addEventListener("pagehide", hide);
  const submitted = (form) => {
    const password = newPasswordsIn(form)[0] || passwordIn(form);
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
    fillCode(code, origin) {
      if (location.origin !== origin || !active || !active.code || !active.el.isConnected || typeof code !== "string" || !CODE_SHAPE.test(code) || !codeField(active.el)) return false;
      setValue(active.el, code);
      open = picking = false;
      return true;
    },
    fillNewPassword(password, origin) {
      if (location.origin !== origin || !active || !active.el.isConnected || typeof password !== "string" || !password) return false;
      const fields = newPasswords(active.el);
      if (!fields.length) return false;
      for (const field of fields) setValue(field, password);
      open = picking = false;
      return true;
    },
    fill(username, password, origin) {
      if (location.origin !== origin) return false;
      const target = active && active.found && active.el.isConnected && active.found.password.isConnected ? active.found : null;
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
"""#
}
