import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const START = "  const fieldProviderKit = ";
const END = "  const nativeMutationObserver = ";
const start = script.indexOf(START);
const end = script.indexOf(END, start);
assert.ok(start > 0 && end > start, "page_script.js has the field provider kit where WebKitPageScript.swift slices it");
const fieldProviderKit = new Function(`${script.slice(start, end)}\nreturn fieldProviderKit;`)();

const LOGIN = { login: true, oneTimeCode: true, codeSetup: true, generation: 1 };

function input(attrs = {}) {
  return {
    localName: "input",
    type: attrs.type ?? "text",
    name: attrs.name ?? "",
    id: attrs.id ?? "",
    disabled: !!attrs.disabled,
    readOnly: !!attrs.readOnly,
    hidden: false,
    value: attrs.value ?? "",
    form: null,
    parentElement: attrs.ownToggle ? toggleScope() : null,
    width: attrs.width ?? 240,
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect() {
      return { width: this.width, height: 32 };
    },
  };
}

function toggleScope() {
  const toggle = { getAttribute: (name) => (name === "aria-label" ? "Show password" : null) };
  return { parentElement: null, querySelectorAll: (selector) => (selector === "input" ? [{}] : [toggle]) };
}

function group(kind, ...fields) {
  const scope = {
    querySelectorAll: (selector) => (selector === "input" ? fields : []),
    querySelector: (selector) => (selector === 'input[type="password"]' ? (fields.find((f) => f.type === "password") ?? null) : null),
    contains: (el) => fields.includes(el),
  };
  for (const field of fields)
    if (kind === "form") field.form = scope;
    else field.parentElement = scope;
  return scope;
}

function image(attrs = {}) {
  return {
    localName: attrs.localName ?? "img",
    complete: attrs.complete ?? true,
    naturalWidth: attrs.naturalWidth ?? 200,
    src: attrs.src ?? "https://site.example/qr.png",
    currentSrc: attrs.src ?? "https://site.example/qr.png",
    qr: attrs.qr,
    getBoundingClientRect: () => ({ width: attrs.width ?? 180, height: attrs.height ?? 180 }),
  };
}

function link(href) {
  return { localName: "a", getAttribute: (name) => (name === "href" ? href : null) };
}

const INTRINSICS = { charCodeAt: String.prototype.charCodeAt, promiseThen: Promise.prototype.then, imul: Math.imul };

const KEY_BOX = { left: 286, top: 47, size: 24, width: 34, color: "black" };

function frame({ barcodes = true, timers = null, isTop = true, toRGBA = () => null } = {}) {
  const sent = [];
  const listeners = {};
  const windowListeners = {};
  const keys = [];
  const observers = [];
  const detected = [];
  let detectors = 0;
  let revealedField = null;
  const document = {
    activeElement: null,
    visibilityState: "visible",
    readyState: "complete",
    images: [],
    links: [],
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    querySelectorAll: (selector) => (selector === "img, canvas" ? document.images : selector === 'a[href^="otpauth" i]' ? document.links : []),
    querySelector: (selector) => (selector === "input" ? {} : null),
    documentElement: { appendChild: (host) => (host.isConnected = true) },
    createElement: (tag) => ({ tag, textContent: "" }),
  };
  class BarcodeDetector {
    constructor(options) {
      detectors++;
      assert.deepEqual(options, { formats: ["qr_code"] });
    }
    detect(el) {
      detected.push(el);
      if (el.pending) return el.pending;
      if (el.qr instanceof Error) return Promise.reject(el.qr);
      return Promise.resolve(el.qr ? [{ rawValue: el.qr, format: "qr_code" }] : []);
    }
  }
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe(target, options) {
      this.observing = true;
      this.options = options;
    }
    disconnect() {
      this.observing = false;
    }
  }
  const hints = [];
  const makeHint = () => {
    const host = { style: {}, isConnected: false, getBoundingClientRect: () => ({ width: 220, height: 28 }) };
    const text = { parts: [], replaceChildren: (...parts) => (text.parts = parts) };
    const close = { attrs: {}, handlers: {}, setAttribute: (k, v) => (close.attrs[k] = v), addEventListener: (t, fn) => (close.handlers[t] = fn) };
    hints.push({ host, text, close });
    return { host, text, close };
  };
  const makeKey = () => {
    const host = { style: {}, isConnected: false };
    const button = { style: {}, attrs: {}, handlers: {}, setAttribute: (k, v) => (button.attrs[k] = v), addEventListener: (t, fn) => (button.handlers[t] = fn) };
    keys.push({ host, button });
    return { host, button };
  };
  const kit = fieldProviderKit({
    document,
    send: (kind, data) => sent.push({ kind, data }),
    guard: (fn) => fn,
    later: (fn) => fn,
    onReady: (fn) => fn(),
    revealed: () => revealedField,
    addListener: function (type, fn) {
      this.addEventListener(type, fn);
    },
    apply: Reflect.apply,
    FrameMutationObserver: MutationObserver,
    setTimeout: timers ? (fn, ms) => timers.push({ fn, ms }) : (fn) => fn(),
    addEventListener: (type, fn) => (windowListeners[type] ??= []).push(fn),
    requestAnimationFrame: () => {},
    isTop,
    makeKey,
    makeHint,
    keyRect: () => KEY_BOX,
    intrinsics: { ...INTRINSICS, Detector: barcodes ? BarcodeDetector : null, detect: BarcodeDetector.prototype.detect, toRGBA },
  });
  const fire = (type, event) => {
    for (const fn of listeners[type] ?? []) fn(event);
  };
  const focus = (el) => {
    document.activeElement = el;
    fire("focusin", { target: el });
  };
  const type = (el, value, trusted = true) => {
    el.value = value;
    fire("input", { target: el, isTrusted: trusted });
  };
  const key = () => keys[0];
  const keyShown = () => key()?.host.style.display === "block";
  const click = (trusted, timeStamp, at = { clientX: KEY_BOX.left + 17, clientY: KEY_BOX.top + 12 }) =>
    key().button.handlers.click({ isTrusted: trusted, timeStamp, ...at, preventDefault() {}, stopPropagation() {} });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const hint = () => hints[0];
  const hintShown = () => hint()?.host.style.display === "block";
  const hintText = () => (hint()?.text.parts ?? []).map((p) => (typeof p === "string" ? p : `<b>${p.textContent}</b>`)).join("");
  return {
    ...kit,
    hintEl: hint,
    hintShown,
    hintText,
    Detector: BarcodeDetector,
    windowListeners,
    document,
    sent,
    listeners,
    windowListeners,
    observers,
    detected,
    focus,
    type,
    key,
    keyShown,
    click,
    settle,
    reveal: (el) => (revealedField = el),
    clicks: () => sent.filter((m) => m.kind === "fieldProvider"),
    codes: () => sent.filter((m) => m.kind === "verificationCode"),
    focusReports: () => sent.filter((m) => m.kind === "fieldFocus"),
    get detectors() {
      return detectors;
    },
  };
}

test("login fields are classified by type, autocomplete and the form around them", () => {
  const { loginFieldKind } = frame();
  assert.equal(loginFieldKind(input({ type: "password" }), null), "password");
  const revealed = input({ type: "text", name: "pw" });
  assert.equal(loginFieldKind(revealed, revealed), "password");
  assert.equal(loginFieldKind(revealed, null), null);
  assert.equal(loginFieldKind(input({ autocomplete: "one-time-code", name: "otp" }), null), "code");
  assert.equal(loginFieldKind(input({ type: "email" }), null), "username");
  assert.equal(loginFieldKind(input({ autocomplete: "username webauthn" }), null), "username");
  assert.equal(loginFieldKind(input({ autocomplete: "off" }), null), null);

  const withPassword = input({ name: "login" });
  group("form", withPassword, input({ type: "password" }));
  assert.equal(loginFieldKind(withPassword, null), "username");
  const withoutPassword = input({ name: "login" });
  group("form", withoutPassword, input({ name: "remember" }));
  assert.equal(loginFieldKind(withoutPassword, null), null);
  const inContainer = input({ type: "tel", placeholder: "Account number" });
  group("container", inContainer, input({ type: "password" }));
  assert.equal(loginFieldKind(inContainer, null), "username");
  const besideRevealed = input({ id: "user" });
  const shownPassword = input({ type: "text", name: "pw" });
  group("form", besideRevealed, shownPassword);
  assert.equal(loginFieldKind(besideRevealed, null), null);
  assert.equal(loginFieldKind(besideRevealed, shownPassword), "username");
  const search = input({ name: "q", placeholder: "Search" });
  group("form", search, input({ type: "password" }));
  assert.equal(loginFieldKind(search, null), null);
  const number = input({ type: "number", name: "user" });
  group("form", number, input({ type: "password" }));
  assert.equal(loginFieldKind(number, null), null);
});

test("disabled, readonly, hidden and narrow fields get no key", () => {
  const { loginFieldKind } = frame();
  assert.equal(loginFieldKind(input({ type: "password", readOnly: true }), null), null);
  assert.equal(loginFieldKind(input({ type: "password", disabled: true }), null), null);
  assert.equal(loginFieldKind(input({ type: "hidden", autocomplete: "username" }), null), null);
  assert.equal(loginFieldKind(input({ type: "password", width: 79 }), null), null);
  assert.equal(loginFieldKind(input({ type: "password", width: 80 }), null), "password");
  assert.equal(loginFieldKind({ localName: "textarea", getAttribute: () => "username", getBoundingClientRect: () => ({ width: 300 }) }, null), null);
});

test("only otpauth setup links up to 2048 characters are accepted", () => {
  const { verificationSetupURL } = frame();
  const totp = "otpauth://totp/Site:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Site";
  assert.equal(verificationSetupURL(totp), totp);
  assert.equal(verificationSetupURL("otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8"), "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8");
  assert.equal(verificationSetupURL("OTPAUTH://hotp/x?secret=AB"), "OTPAUTH://hotp/x?secret=AB");
  assert.equal(verificationSetupURL("https://site.example/?otpauth://totp"), null);
  assert.equal(verificationSetupURL("javascript:alert(1)//otpauth://totp"), null);
  assert.equal(verificationSetupURL("otpauth:totp/x?secret=AB"), null);
  assert.equal(verificationSetupURL(" otpauth://totp/x?secret=AB"), null);
  const prefix = "otpauth://totp/x?secret=";
  assert.equal(verificationSetupURL(prefix + "A".repeat(2048 - prefix.length)), prefix + "A".repeat(2048 - prefix.length));
  assert.equal(verificationSetupURL(prefix + "A".repeat(2049 - prefix.length)), null);
  assert.equal(verificationSetupURL(null), null);
});

test("with no provider nothing listens, scans, reports or shows", async () => {
  const page = frame();
  page.document.images = [image({ qr: "otpauth://totp/x?secret=AB" })];
  page.document.links = [link("otpauth://totp/x?secret=AB")];
  page.configure(false);
  page.configure("true");
  page.configure({ login: false, oneTimeCode: false, codeSetup: false, generation: 3 });
  page.focus(input({ type: "password" }));
  await page.settle();
  assert.deepEqual(Object.keys(page.listeners), []);
  assert.deepEqual(Object.keys(page.windowListeners), []);
  assert.equal(page.observers.length, 0);
  assert.equal(page.detectors, 0);
  assert.equal(page.key(), undefined);
  assert.deepEqual(page.sent, []);
});

test("the key asks for the panel only on a trusted click inside it, once per 600 ms, with the generation", () => {
  const page = frame();
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  assert.equal(page.keyShown(), true);
  assert.equal(page.key().button.attrs["aria-label"], "Fill from Passwords");

  page.click(false, 1000);
  assert.deepEqual(page.clicks(), []);
  page.click(true, 1000);
  page.click(true, 1500);
  page.click(true, 1700);
  page.click(true, 2000, { clientX: 20, clientY: 20 });
  assert.deepEqual(page.clicks(), [
    { kind: "fieldProvider", data: { field: "password", generation: 1 } },
    { kind: "fieldProvider", data: { field: "password", generation: 1 } },
  ]);
  page.focus(input({ autocomplete: "one-time-code" }));
  page.click(true, 3000);
  assert.deepEqual(page.clicks().at(-1), { kind: "fieldProvider", data: { field: "code", generation: 1 } });
});

test("a provider for codes only shows the key in code fields, and one for logins only in login fields", () => {
  const page = frame();
  page.configure({ login: false, oneTimeCode: true, codeSetup: false, generation: 2 });
  page.focus(input({ type: "password" }));
  assert.equal(page.keyShown(), false);
  page.focus(input({ autocomplete: "one-time-code" }));
  assert.equal(page.keyShown(), true);
  page.configure({ login: true, oneTimeCode: false, codeSetup: false, generation: 3 });
  assert.equal(page.keyShown(), false);
  page.focus(input({ type: "email" }));
  assert.equal(page.keyShown(), true);
});

test("the key gives way once the user types, and comes back for filled-in values", () => {
  const page = frame();
  page.configure(LOGIN);
  const password = input({ type: "password", value: "prefilled" });
  page.focus(password);
  assert.equal(page.keyShown(), true);
  page.type(password, "hunter2");
  assert.equal(page.keyShown(), false);
  page.type(password, "");
  assert.equal(page.keyShown(), true);
  const email = input({ type: "email" });
  page.focus(email);
  page.type(email, "me@example.com");
  assert.equal(page.keyShown(), false);
  page.type(email, "", true);
  page.type(email, "filled@example.com", false);
  assert.equal(page.keyShown(), true);
  page.focus(input({ type: "password", ownToggle: true }));
  assert.equal(page.keyShown(), false);
  page.focus(input({ name: "q" }));
  assert.equal(page.keyShown(), false);
});

test("removing the provider hides the key live and stops it sending", () => {
  const page = frame();
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  assert.equal(page.observers[0].observing, true);
  page.configure(false);
  assert.equal(page.keyShown(), false);
  assert.equal(page.observers[0].observing, false);
  page.focus(input({ type: "password" }));
  assert.equal(page.keyShown(), false);
  page.click(true, 5000);
  assert.deepEqual(page.clicks(), []);
});

test("the top frame reports which wanted field holds focus, only when it changes, with the generation", () => {
  const page = frame();
  page.configure({ login: true, oneTimeCode: false, codeSetup: false, generation: 4 });
  assert.deepEqual(page.focusReports(), [{ kind: "fieldFocus", data: { field: null, seq: 1, generation: 4 } }]);
  page.focus(input({ type: "password" }));
  page.focus(input({ type: "password" }));
  page.focus(input({ autocomplete: "one-time-code" }));
  page.focus(input({ type: "email" }));
  assert.deepEqual(
    page.focusReports().map((m) => m.data.field),
    [null, "password", null, "username"],
  );
  page.configure({ login: true, oneTimeCode: false, codeSetup: false, generation: 5 });
  const last = page.focusReports().at(-1).data;
  assert.deepEqual([last.field, last.generation], ["username", 5]);
});

test("the top frame looks into a same-origin iframe for the focused field, never into a cross-origin one", () => {
  const page = frame();
  page.configure(LOGIN);
  const innerListeners = {};
  const password = input({ type: "password" });
  const inner = { activeElement: password, addEventListener: (type, fn) => (innerListeners[type] ??= []).push(fn) };
  page.focus({ localName: "iframe", contentDocument: inner, getAttribute: () => null });
  assert.equal(page.focusReports().at(-1).data.field, "password");
  assert.ok(innerListeners.focusin && innerListeners.focusout, "focus changes inside the frame are followed");
  inner.activeElement = null;
  for (const fn of innerListeners.focusout) fn({});
  assert.equal(page.focusReports().at(-1).data.field, null);

  const crossOrigin = {
    localName: "iframe",
    getAttribute: () => null,
    get contentDocument() {
      throw new Error("SecurityError");
    },
  };
  page.focus(crossOrigin);
  assert.equal(page.focusReports().at(-1).data.field, null);
});

test("a subframe never reports focus", () => {
  const page = frame({ isTop: false });
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  assert.deepEqual(page.focusReports(), []);
  assert.equal(page.keyShown(), true);
});

test("otpauth links and QR codes are reported once per link and generation", async () => {
  const page = frame();
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  page.document.links = [link(totp), link("otpauth://nothing"), link("https://site.example")];
  page.document.images = [
    image({ qr: totp }),
    image({ qr: "https://site.example/app", src: "https://site.example/link.png" }),
    image({ qr: new Error("SecurityError"), src: "https://other.example/qr.png" }),
    image({ localName: "canvas", qr: "otpauth-migration://offline?data=AB", src: "" }),
  ];
  page.configure(LOGIN);
  await page.settle();
  assert.deepEqual(page.codes(), [
    { kind: "verificationCode", data: { url: totp, generation: 1 } },
    { kind: "verificationCode", data: { url: "otpauth://nothing", generation: 1 } },
    { kind: "verificationCode", data: { url: "otpauth-migration://offline?data=AB", generation: 1 } },
  ]);
  page.observers[0].callback();
  await page.settle();
  assert.equal(page.codes().length, 3);

  page.configure({ ...LOGIN, generation: 2 });
  await page.settle();
  assert.deepEqual(
    page.codes().slice(3).map((m) => m.data),
    [
      { url: totp, generation: 2 },
      { url: "otpauth://nothing", generation: 2 },
      { url: "otpauth-migration://offline?data=AB", generation: 2 },
    ],
  );
});

test("codes are only looked for when the provider sets them up", async () => {
  const page = frame();
  page.document.links = [link("otpauth://totp/x?secret=AB")];
  page.document.images = [image({ qr: "otpauth://totp/x?secret=AB" })];
  page.configure({ login: true, oneTimeCode: true, codeSetup: false, generation: 1 });
  await page.settle();
  assert.deepEqual(page.codes(), []);
  assert.equal(page.observers.length, 0);
  assert.equal(page.detectors, 0);
});

test("a QR result that arrives after the generation changed is dropped", async () => {
  const page = frame();
  let release;
  const slow = image();
  slow.pending = new Promise((resolve) => (release = resolve));
  page.document.images = [slow];
  page.configure({ login: false, oneTimeCode: false, codeSetup: true, generation: 1 });
  page.configure({ login: false, oneTimeCode: false, codeSetup: true, generation: 2 });
  assert.equal(page.detected.length, 2);
  release([{ rawValue: "otpauth://totp/x?secret=AB", format: "qr_code" }]);
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: "otpauth://totp/x?secret=AB", generation: 2 } }]);
});

test("without BarcodeDetector, as in WebKit, otpauth links are still found", async () => {
  const page = frame({ barcodes: false });
  page.document.links = [link("otpauth://totp/x?secret=AB")];
  page.document.images = [image({ qr: "otpauth://totp/y?secret=AB" })];
  page.configure(LOGIN);
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: "otpauth://totp/x?secret=AB", generation: 1 } }]);
  assert.equal(page.detectors, 0);
});

test("a QR image inside a hidden container is scanned once it is shown", async () => {
  const page = frame();
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  const hidden = image({ qr: totp });
  hidden.getBoundingClientRect = () => ({ width: 0, height: 0 });
  page.document.images = [hidden];
  page.configure(LOGIN);
  await page.settle();
  assert.deepEqual(page.codes(), []);
  assert.equal(page.detected.length, 0);
  hidden.getBoundingClientRect = () => ({ width: 180, height: 180 });
  page.observers[0].callback();
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: totp, generation: 1 } }]);
});

test("revealing a QR image through an ancestor's class, style or hidden change triggers a scan", async () => {
  const page = frame();
  page.configure(LOGIN);
  await page.settle();
  const { attributes, subtree, attributeFilter } = page.observers[0].options;
  assert.ok(attributes && subtree);
  for (const name of ["class", "style", "hidden", "src", "href"]) assert.ok(attributeFilter.includes(name), name);
});

test("a QR image laid out too small or stretched is checked again once its layout changes", async () => {
  const page = frame();
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  const small = image({ qr: totp });
  small.getBoundingClientRect = () => ({ width: 20, height: 20 });
  page.document.images = [small];
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.detected.length, 0);
  small.getBoundingClientRect = () => ({ width: 180, height: 60 });
  page.observers[0].callback();
  await page.settle();
  assert.equal(page.detected.length, 0);
  small.getBoundingClientRect = () => ({ width: 180, height: 180 });
  page.observers[0].callback();
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: totp, generation: 1 } }]);
});

test("a canvas whose first QR code isn't a setup code keeps its retries for a setup code drawn later", async () => {
  const timers = [];
  const page = frame({ timers });
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  const canvas = image({ localName: "canvas", src: "", qr: "https://site.example/download-the-app" });
  page.document.images = [canvas];
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.detected.length, 1);
  assert.deepEqual(page.codes(), []);
  canvas.qr = totp;
  page.focus(input({ autocomplete: "one-time-code" }));
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: totp, generation: 1 } }]);
});

test("a QR code drawn into a canvas after its first scan is found later, with a bounded number of tries", async () => {
  const timers = [];
  const page = frame({ timers });
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  const canvas = image({ localName: "canvas", src: "" });
  page.document.images = [canvas];
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.detected.length, 1);
  assert.deepEqual(page.codes(), []);
  canvas.qr = totp;
  page.focus(input({ autocomplete: "one-time-code" }));
  await page.settle();
  assert.deepEqual(page.codes(), [{ kind: "verificationCode", data: { url: totp, generation: 1 } }]);
  const scans = page.detected.length;
  page.focus(input({ autocomplete: "one-time-code" }));
  await page.settle();
  assert.equal(page.detected.length, scans);
});

test("a canvas that never shows a QR code is scanned at most three times", async () => {
  const timers = [];
  const page = frame({ timers });
  page.document.images = [image({ localName: "canvas", src: "" })];
  page.configure(LOGIN);
  await page.settle();
  for (let i = 0; i < 6; i++) {
    for (const timer of timers.splice(0)) timer.fn();
    page.focus(input({ autocomplete: "one-time-code" }));
    await page.settle();
  }
  assert.equal(page.detected.length, 3);
});

test("the WebKit page script slices the same kit out of page_script.js", () => {
  const swift = readFileSync(new URL("../../../../packages/ardiacore/ios/WebKitPageScript.swift", import.meta.url), "utf8");
  assert.ok(swift.includes(JSON.stringify(START)), "WebKitPageScript.swift starts the slice where this test does");
  assert.ok(swift.includes(JSON.stringify(END)), "WebKitPageScript.swift ends the slice where this test does");
});

test("focus leaving a login field is reported at once, before any deferred check runs, with a rising sequence", () => {
  const timers = [];
  const page = frame({ timers });
  page.configure(LOGIN);
  for (const timer of timers.splice(0)) timer.fn();
  const password = input({ type: "password" });
  page.focus(password);
  for (const timer of timers.splice(0)) timer.fn();
  assert.equal(page.focusReports().at(-1).data.field, "password");
  const crossOrigin = {
    localName: "iframe",
    getAttribute: () => null,
    get contentDocument() {
      throw new Error("SecurityError");
    },
  };
  page.document.activeElement = crossOrigin;
  for (const fn of page.listeners.focusout ?? []) fn({ target: password });
  assert.equal(page.focusReports().at(-1).data.field, null, "the loss is reported before the deferred recheck");
  for (const fn of page.listeners.focusin ?? []) fn({ target: crossOrigin });
  assert.equal(page.focusReports().at(-1).data.field, null);
  const seqs = page.focusReports().map((m) => m.data.seq);
  assert.ok(seqs.every((s, i) => typeof s === "number" && (i === 0 || s > seqs[i - 1])), `sequences rise: ${seqs}`);
});

test("found setup codes are remembered only as a short hash, and forgotten when the provider is withdrawn", async () => {
  const page = frame();
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  assert.equal(typeof page.codeKey, "function", "the kit exposes the key it remembers codes by");
  const key = page.codeKey(totp);
  assert.ok(!String(key).includes("JBSWY3DPEHPK3PXP") && String(key).length <= 16, `key ${key} hides the secret`);
  assert.notEqual(page.codeKey(totp + "A"), key);
  page.document.links = [link(totp)];
  page.configure(LOGIN);
  await page.settle();
  page.configure(false);
  assert.equal(page.rememberedCodes(), 0, "withdrawing forgets what was found");
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.codes().length, 2, "the same code is offered again after the provider comes back");
});

test("a decoded setup code never passes through a function the page can replace", async () => {
  const page = frame();
  const totp = "otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP";
  page.document.links = [link(totp)];
  page.document.images = [image({ qr: "otpauth://totp/Qr:me?secret=KRSXG5CTMVRXEZLU" })];
  const seen = [];
  const includes = String.prototype.includes;
  const apply = Reflect.apply;
  const isArray = Array.isArray;
  const secret = (value) => typeof value === "string" && apply(includes, value, ["secret="]);
  const leaks = (value) => {
    if (secret(value)) return true;
    if (value && typeof value === "object" && secret(value.rawValue)) return true;
    if (isArray(value)) for (let i = 0; i < value.length; i++) if (leaks(value[i])) return true;
    return false;
  };
  const hooks = [
    [String.prototype, "charCodeAt"],
    [RegExp.prototype, "test"],
    [RegExp.prototype, "exec"],
    [Promise.prototype, "then"],
    [Array.prototype, Symbol.iterator],
    [Math, "imul"],
  ];
  const originals = hooks.map(([target, name]) => target[name]);
  hooks.forEach(([target, name], i) => {
    const original = originals[i];
    const label = typeof name === "symbol" ? "Symbol.iterator" : name;
    target[name] = function (...args) {
      if (leaks(this)) seen[seen.length] = label;
      for (let j = 0; j < args.length; j++) {
        if (leaks(args[j])) seen[seen.length] = label;
        if (label === "then" && typeof args[j] === "function") {
          const callback = args[j];
          args[j] = function (value) {
            if (leaks(value)) seen[seen.length] = label;
            return apply(callback, this, [value]);
          };
        }
      }
      return apply(original, this, args);
    };
  });
  try {
    page.configure(LOGIN);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    hooks.forEach(([target, name], i) => (target[name] = originals[i]));
  }
  assert.equal(page.codes().length, 2, "both codes were still found");
  assert.deepEqual(seen, [], "no replaceable function saw a decoded code");
});

test("a subframe never reports setup codes, from links or QR codes", async () => {
  const page = frame({ isTop: false });
  page.document.links = [link("otpauth://totp/x?secret=AB")];
  page.document.images = [image({ qr: "otpauth://totp/y?secret=AB" })];
  page.configure(LOGIN);
  await page.settle();
  assert.deepEqual(page.codes(), []);
  assert.equal(page.detectors, 0);
});

test("a focus query gets a fresh report tied to the query, even when nothing changed, and only from the top frame", () => {
  const page = frame();
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  const before = page.focusReports().at(-1).data;
  page.focusQuery("q1");
  const answer = page.focusReports().at(-1).data;
  assert.deepEqual([answer.field, answer.query], ["password", "q1"]);
  assert.ok(answer.seq > before.seq);
  const crossOrigin = {
    localName: "iframe",
    getAttribute: () => null,
    get contentDocument() {
      throw new Error("SecurityError");
    },
  };
  page.document.activeElement = crossOrigin;
  page.focusQuery("q2");
  assert.deepEqual([page.focusReports().at(-1).data.field, page.focusReports().at(-1).data.query], [null, "q2"]);
  page.configure(false);
  const count = page.focusReports().length;
  page.focusQuery("q3");
  assert.equal(page.focusReports().length, count, "no provider, no answer");

  const sub = frame({ isTop: false });
  sub.configure(LOGIN);
  sub.focusQuery("q4");
  assert.deepEqual(sub.focusReports(), []);
});

test("the key's ink follows the field's own background, then its ancestors', then its text colour", () => {
  const { badgeInk } = frame();
  assert.equal(badgeInk(["rgb(13, 17, 23)"], "rgb(230, 237, 243)"), "#ffffff");
  assert.equal(badgeInk(["rgb(255, 255, 255)"], "rgb(31, 35, 40)"), "#1d1d1f");
  assert.equal(badgeInk(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.1)", "rgb(13, 17, 23)"], "rgb(0, 0, 0)"), "#ffffff");
  assert.equal(badgeInk(["rgba(0, 0, 0, 0)", "rgb(246, 248, 250)"], "rgb(255, 255, 255)"), "#1d1d1f");
  assert.equal(badgeInk(["rgb(110, 118, 129)"], "rgb(255, 255, 255)"), "#ffffff");
  assert.equal(badgeInk(["rgb(0 0 0 / 0)"], "rgb(230, 237, 243)"), "#ffffff");
  assert.equal(badgeInk([], "rgb(31, 35, 40)"), "#1d1d1f");
  assert.equal(badgeInk(["color(srgb 0.1 0.1 0.1)"], "oklch(0.9 0 0)"), "#1d1d1f");
});

test("the QR scan calls the detector captured at script start, never one the page swaps in later", async () => {
  const page = frame();
  const swapped = [];
  const original = page.Detector.prototype.detect;
  page.Detector.prototype.detect = function (el) {
    swapped.push(el);
    return Reflect.apply(original, this, [el]);
  };
  page.document.images = [image({ qr: "otpauth://totp/x?secret=AB" })];
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.codes().length, 1, "the code is still found");
  assert.equal(swapped.length, 0, "the page's detect was never called");
});

test("a page restored from the back/forward cache offers its code again", async () => {
  const page = frame();
  page.document.links = [link("otpauth://totp/x?secret=AB")];
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.codes().length, 1);
  for (const fn of page.windowListeners.pageshow ?? []) fn({ isTrusted: false, persisted: true });
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.codes().length, 1, "an untrusted pageshow changes nothing");
  for (const fn of page.windowListeners.pageshow ?? []) fn({ isTrusted: true, persisted: true });
  page.configure(LOGIN);
  await page.settle();
  assert.equal(page.codes().length, 2, "the restored page offers its code again");
});

test("a dark field in any colour space gets light ink, read through the colour normaliser", () => {
  const painted = { "oklch(0.2 0.02 260)": { r: 21, g: 24, b: 32, a: 1 }, "color(display-p3 0.95 0.95 0.95)": { r: 243, g: 243, b: 243, a: 1 } };
  const { badgeInk } = frame({ toRGBA: (css) => painted[css] ?? null });
  assert.equal(badgeInk(["oklch(0.2 0.02 260)"], "oklch(0.95 0 0)"), "#ffffff");
  assert.equal(badgeInk(["color(display-p3 0.95 0.95 0.95)"], "rgb(255, 255, 255)"), "#1d1d1f");
  assert.equal(badgeInk(["lab(10 0 0 / 0)", "oklch(0.2 0.02 260)"], "rgb(0, 0, 0)"), "#ffffff");
});

test("oklab and oklch backgrounds, as Tailwind v4 and discord emit them, get ink from their measured luminance", () => {
  const painted = {
    "oklab(0 0 0 / 0.121569)": { r: 0, g: 0, b: 0, a: 0.12 },
    "oklab(0.262392 0.002511 -0.008907)": { r: 44, g: 46, b: 51, a: 1 },
    "oklab(0.952699 0.00075 -0.002555)": { r: 241, g: 242, b: 243, a: 1 },
    "oklch(0.97 0.01 250)": { r: 242, g: 246, b: 252, a: 1 },
    "oklch(0.25 0.03 260)": { r: 26, g: 31, b: 44, a: 1 },
  };
  const { badgeInk } = frame({ toRGBA: (css) => painted[css] ?? null });
  assert.equal(badgeInk(["rgba(0, 0, 0, 0)", "oklab(0 0 0 / 0.121569)", "oklab(0.262392 0.002511 -0.008907)"], "oklab(0.952699 0.00075 -0.002555)"), "#ffffff");
  assert.equal(badgeInk(["oklch(0.97 0.01 250)"], "oklch(0.25 0.03 260)"), "#1d1d1f");
  assert.equal(badgeInk(["oklch(0.25 0.03 260)"], "rgb(0, 0, 0)"), "#ffffff");
  assert.equal(badgeInk(["rgba(0, 0, 0, 0)"], "oklab(0.952699 0.00075 -0.002555)"), "#ffffff", "a light text colour alone says dark");
});

test("when no colour can be read at all, the page's own scheme picks the ink, never dark ink by default", () => {
  const { badgeInk } = frame({ toRGBA: () => null });
  assert.equal(badgeInk(["unreadable(1)"], "unreadable(2)", true), "#ffffff");
  assert.equal(badgeInk(["unreadable(1)"], "unreadable(2)", () => true), "#ffffff");
  assert.equal(badgeInk(["unreadable(1)"], "unreadable(2)", false), "#1d1d1f");
});

test("the panel hint shows beside a shown key, names only the label it was given, and reports itself", () => {
  const page = frame();
  page.configure(LOGIN);
  page.hint({ label: "github", side: "below" });
  assert.equal(page.hintShown(), false, "no key, no hint");
  const password = input({ type: "password" });
  page.focus(password);
  page.hint({ label: "github", side: "below" });
  assert.equal(page.hintShown(), true);
  assert.equal(page.hintText(), "Type <b>github</b> in Passwords to find this site");
  assert.equal(page.hintEl().host.style.top, `${47 + 24 + 8}px`, "below the key");
  assert.equal(page.hintEl().host.style.left, `${286 + 34 - 220}px`, "right edge lined up with the key's");
  assert.deepEqual(page.sent.filter((m) => m.kind === "fieldProviderHint").map((m) => m.data), [{ state: "shown" }]);
  page.hint({ label: "github", side: "above" });
  assert.equal(page.hintEl().host.style.top, `${Math.max(4, 47 - 8 - 28)}px`, "above the key");
});

test("the hint refuses labels that aren't one domain label", () => {
  const page = frame();
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  for (const label of ["", "github.com", "Git Hub", "<b>x</b>", "-x", "x-", "a".repeat(64), 42]) {
    page.hint({ label, side: "below" });
    assert.equal(page.hintShown(), false, `label ${label}`);
  }
  page.hint({ label: "xn--bcher-kva", side: "below" });
  assert.equal(page.hintShown(), true);
});

test("the hint closes when focus moves to another field, the key hides, the provider goes or Ardia says so", () => {
  const page = frame();
  page.configure(LOGIN);
  const password = input({ type: "password" });
  page.focus(password);
  page.hint({ label: "github", side: "below" });
  page.focus(input({ type: "email" }));
  assert.equal(page.hintShown(), false, "another field");
  page.focus(password);
  page.hint({ label: "github", side: "below" });
  page.hint(false);
  assert.equal(page.hintShown(), false, "the panel closed");
  page.hint({ label: "github", side: "below" });
  page.type(password, "hunter2");
  assert.equal(page.hintShown(), false, "the field was filled");
  page.type(password, "");
  page.hint({ label: "github", side: "below" });
  page.configure(false);
  assert.equal(page.hintShown(), false, "the provider went away");
});

test("only a trusted click on the hint's close button dismisses it, and the dismissal is reported", () => {
  const page = frame();
  page.configure(LOGIN);
  page.focus(input({ type: "password" }));
  page.hint({ label: "github", side: "below" });
  const click = (isTrusted) => page.hintEl().close.handlers.click({ isTrusted, preventDefault() {}, stopPropagation() {} });
  click(false);
  assert.equal(page.hintShown(), true);
  click(true);
  assert.equal(page.hintShown(), false);
  assert.deepEqual(page.sent.filter((m) => m.kind === "fieldProviderHint").map((m) => m.data.state), ["shown", "dismissed"]);
});
