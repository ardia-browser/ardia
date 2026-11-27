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
  const NEW_PASSWORD = /(^|\s)new-password(\s|$)/i;
  const CURRENT_PASSWORD = /(^|\s)current-password(\s|$)/i;
  const passwordsIn = (root) => Array.from((root || document).querySelectorAll("input[type=password]")).filter(visible);
  const newPasswordsIn = (root) => {
    const all = passwordsIn(root);
    const marked = all.filter((el) => NEW_PASSWORD.test(el.getAttribute("autocomplete") || ""));
    const unmarked = all.filter((el) => !CURRENT_PASSWORD.test(el.getAttribute("autocomplete") || ""));
    return marked.length ? marked : unmarked.length < all.length ? unmarked : all.length === 2 ? all : all.length === 3 ? all.slice(1) : [];
  };
  const signUpForm = (root) => {
    const all = passwordsIn(root);
    return all.length > 0 && newPasswordsIn(root).length === all.length;
  };
  const SIGN_IN_STEP = /^(next|continue|sign ?in|log ?in)\b/i;
  const textInputs = (form) => Array.from(form.querySelectorAll("input")).filter((el) => visible(el) && /^(text|email|tel|)$/i.test(el.getAttribute("type") || ""));
  const submitLabel = (form) => {
    const button = form.querySelector("button[type=submit], button:not([type]), input[type=submit]");
    if (!button) return "";
    return String((button.tagName === "INPUT" ? button.value : button.textContent) || "").trim().slice(0, 40);
  };
  const identifierField = (el) => {
    if (!/^(text|email|)$/i.test(el.getAttribute("type") || "")) return false;
    if ((el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).includes("username")) return true;
    const inputs = el.form ? textInputs(el.form) : [];
    return inputs.length === 1 && inputs[0] === el && SIGN_IN_STEP.test(submitLabel(el.form));
  };
  const loginField = (el) => {
    if (!el || el.tagName !== "INPUT" || !visible(el)) return null;
    if (el.type === "password") return { password: el, username: usernameFor(el) };
    const password = passwordIn(el.form || document);
    if (!password) return identifierField(el) ? { password: null, username: el } : null;
    if (usernameFor(password) !== el || signUpForm(password.form || document)) return null;
    return { password, username: el };
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
  const inTopViewport = (el) => {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    for (let view = el.ownerDocument.defaultView; view && view !== view.top; view = view.parent) {
      const host = view.frameElement;
      if (!host) return null;
      const at = host.getBoundingClientRect();
      x += at.left + host.clientLeft;
      y += at.top + host.clientTop;
    }
    return { x, y, width: r.width, height: r.height };
  };
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
    const r = inTopViewport(el);
    if (!r) return hide();
    active = { el, found, code, fresh };
    post("loginField", {
      event, origin: location.origin, password: isPassword, code, newPassword: fresh.length > 0, identifier: !!found && !found.password, ...(fresh.length ? passwordRules(fresh) : {}),
      value: isPassword || code ? "" : String(el.value || "").slice(0, 200),
      x: r.x, y: r.y, width: r.width, height: r.height,
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
      const target = active && active.found && active.el.isConnected && (active.found.password || active.found.username).isConnected ? active.found : null;
      if (target && !target.password) {
        if (!username) return false;
        setValue(target.username, username);
        open = picking = false;
        return true;
      }
      const field = target ? target.password : passwordIn(document);
      if (!field || !password) return false;
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
