import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pageScript = read("../ios/WebKitPageScript.swift");
const faultsSwift = read("../ios/WebKitMediaFaults.swift");
const tab = read("../ios/WebKitTab.swift");
const engines = read("../../../apps/browser/src/state/engines/engines.ts");

const strings = (text) => [...text.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
const listIn = (text, pattern) => {
  const found = text.match(pattern);
  assert.ok(found, `${pattern} not found`);
  return strings(found[1]);
};
const sites = listIn(faultsSwift, /static let sites = \[([^\]]*)\]/);
const reasons = listIn(faultsSwift, /static let reasons: Set<String> = \[([^\]]*)\]/);
const rawString = (text, name) => {
  const start = text.indexOf(`static let ${name} = #"""`);
  assert.ok(start >= 0, `${name} not found`);
  const from = text.indexOf('"""', start) + 3;
  return text.slice(from, text.indexOf('"""#', from));
};
const filled = (script) => script.replace("\\#(WebKitMediaFaults.sitesJSON)", JSON.stringify(sites)).replace("\\#(WebKitMediaFaults.pageScript)", rawString(faultsSwift, "pageScript"));
const bridge = filled(rawString(pageScript, "mediaBridge"));
const source = filled(rawString(pageScript, "source"));

test("the streaming sites are the protected video sites the app opens in WebKit", () => {
  const listed = listIn(engines, /export const PROTECTED_VIDEO_SITES: readonly string\[\] = \[([^\]]*)\]/);
  assert.ok(listed.length > 10);
  assert.deepEqual(sites, listed);
});

test("the reasons a page can report are a fixed set, each short enough to send", () => {
  assert.equal(reasons.length, 42);
  assert.equal(new Set(reasons).size, reasons.length);
  assert.ok(reasons.every((reason) => /^[a-z_]{1,48}$/.test(reason)));
});

test("a media fault from a page is passed on only for a streaming site over https, with the tab's mute and content blocker state", () => {
  const start = tab.indexOf('case "mediaFault":');
  assert.ok(start > 0);
  const handler = tab.slice(start, tab.indexOf('case "status":', start));
  assert.match(handler, /WebKitMediaFaults\.event\(dict, from: frameInfo, muted: muted, blockerActive: WebKitContentBlocker\.shared\.isFiltering && !blocked\.exemptLoad\)/);
  assert.match(handler, /emit\("mediaFault", fault\)/);
  const event = faultsSwift.slice(faultsSwift.indexOf("static func event"));
  assert.match(event, /reasons\.contains\(reason\)/);
  assert.match(event, /origin\.protocol == "https"/);
  assert.match(event, /isStreamingSite\(host: origin\.host\.lowercased\(\)\)/);
  assert.match(event, /return \["reason": reason, "muted": muted, "blockerActive": blockerActive\]/);
  assert.doesNotMatch(handler + event, /\b(url|title|absoluteString)\b/i);
});

const prelude = `
class EventTarget {
  addEventListener(type, fn, capture) { (this._listeners ||= []).push({ type, fn, capture: capture === true }); }
  dispatchEvent(event) {
    event._target = this;
    if (this === document || this.isConnected) for (const l of document._listeners || []) if (l.type === event.type && (l.capture || this === document)) l.fn(event);
    if (this !== document) for (const l of this._listeners || []) if (l.type === event.type) l.fn(event);
    return true;
  }
}
class Event { constructor(type) { this.type = type; } get target() { return this._target; } preventDefault() {} }
class CustomEvent extends Event { constructor(type, init = {}) { super(type); this._detail = init.detail ?? null; } get detail() { return this._detail; } }
class MouseEvent extends Event { constructor(type, init = {}) { super(type); this.relatedTarget = init.relatedTarget ?? null; } }
class Node extends EventTarget { get isConnected() { return !this._detached; } }
class MediaError { constructor(code) { this._code = code; } get code() { return this._code; } }
class HTMLMediaElement extends Node {
  get error() { return this._error ?? null; }
  play() { return this.answer(); }
  answer() { return undefined; }
}
class DOMException { constructor(message, name) { this._name = name; } get name() { return this._name; } get code() { return this._code ?? 0; } }
class Navigator {
  requestMediaKeySystemAccess(name, configurations) { return this.answer(name, configurations); }
  answer() { return undefined; }
}
class WebKitMediaKeyError { constructor(code) { this._code = code; } get code() { return this._code; } }
class WebKitMediaKeySession extends EventTarget { get error() { return this._error ?? null; } }
class WebKitMediaKeys {
  static isTypeSupported(name) { return WebKitMediaKeys.supported.includes(name); }
  createSession() { return new WebKitMediaKeySession(); }
}
WebKitMediaKeys.supported = ["com.apple.fps"];
globalThis.WebKitMediaKeyError = WebKitMediaKeyError;
globalThis.WebKitMediaKeySession = WebKitMediaKeySession;
globalThis.WebKitMediaKeys = WebKitMediaKeys;
globalThis.originalIsTypeSupported = WebKitMediaKeys.isTypeSupported;
globalThis.originalCreateSession = WebKitMediaKeys.prototype.createSession;
globalThis.EventTarget = EventTarget;
globalThis.Event = Event;
globalThis.CustomEvent = CustomEvent;
globalThis.MouseEvent = MouseEvent;
globalThis.Node = Node;
globalThis.MediaError = MediaError;
globalThis.HTMLMediaElement = HTMLMediaElement;
globalThis.DOMException = DOMException;
globalThis.Navigator = Navigator;
globalThis.document = new EventTarget();
Object.assign(document, { readyState: "complete", removeEventListener() {}, querySelectorAll: () => [], pictureInPictureElement: null, body: null, documentElement: {} });
globalThis.navigator = new Navigator();
globalThis.originalAccess = Navigator.prototype.requestMediaKeySystemAccess;
globalThis.originalPlay = HTMLMediaElement.prototype.play;
`;

function page({ protocol = "https:", hostname = sites[0] } = {}) {
  const posted = [];
  const window = {
    location: { protocol, hostname },
    addEventListener() {},
    performance: { now: () => 0 },
    setTimeout() {},
    requestAnimationFrame() {},
    webkit: { messageHandlers: { ardia: { postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) } } },
  };
  window.window = window;
  window.top = window;
  createContext(window);
  const run = (code) => runInContext(code, window);
  run(prelude);
  run(source);
  run(bridge);
  const json = (code) => JSON.parse(runInContext(`JSON.stringify(${code})`, window));
  const faults = () => posted.filter((m) => m.kind === "mediaFault");
  const drm = () => posted.filter((m) => m.kind === "drm").map((m) => m.data);
  return { run, json, faults, drm, reported: () => faults().map((m) => m.data.reason) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a key system the page asks for and gets is reported by name as granted, and the page gets its own result", async () => {
  const p = page();
  p.run(`
    navigator.answer = (name) => Promise.resolve({ keySystem: name });
    globalThis.results = [];
    for (const name of ["com.widevine.alpha", "com.microsoft.playready.recommendation", "com.apple.fps.1_0", "org.w3.clearkey"]) {
      navigator.requestMediaKeySystemAccess(name, [{}]).then((access) => results.push(access.keySystem));
    }
  `);
  await settle();
  assert.deepEqual(p.json("results"), ["com.widevine.alpha", "com.microsoft.playready.recommendation", "com.apple.fps.1_0", "org.w3.clearkey"]);
  assert.deepEqual(p.reported(), ["eme_widevine_granted", "eme_playready_granted", "eme_fairplay_granted", "eme_other_granted"]);
});

test("a refused key system request is reported with the error's name and the page catches the same error", async () => {
  const p = page();
  p.run(`
    globalThis.failures = [new DOMException("no CDM", "NotSupportedError"), new DOMException("insecure", "SecurityError"), new DOMException("blocked", "NotAllowedError"), new TypeError("odd")];
    navigator.answer = (name) => Promise.reject(failures.shift());
    globalThis.thrown = [];
    globalThis.expected = failures.slice();
    for (const name of ["com.widevine.alpha", "com.microsoft.playready", "com.apple.fps", "org.w3.clearkey"]) {
      navigator.requestMediaKeySystemAccess(name, [{}]).catch((error) => thrown.push(error));
    }
  `);
  await settle();
  assert.equal(p.run("thrown.length === 4 && thrown.every((error, i) => error === expected[i])"), true);
  assert.deepEqual(p.reported(), ["eme_widevine_refused_not_supported", "eme_playready_refused_security", "eme_fairplay_refused_not_allowed", "eme_other_refused_other"]);
});

test("a request that doesn't return a promise reaches the page untouched", () => {
  const p = page();
  assert.equal(p.run("navigator.answer = () => 7; navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{}])"), 7);
  assert.deepEqual(p.reported(), []);
});

test("a play() the page is refused is reported by the error's name and the page catches the same error", async () => {
  const p = page();
  p.run(`
    globalThis.failures = [new DOMException("", "NotAllowedError"), new DOMException("", "NotSupportedError"), new DOMException("", "AbortError"), new Error("song title")];
    globalThis.expected = failures.slice();
    globalThis.thrown = [];
    const video = new HTMLMediaElement();
    video.answer = () => Promise.reject(failures.shift());
    for (let i = 0; i < 4; i++) video.play().catch((error) => thrown.push(error));
  `);
  await settle();
  assert.equal(p.run("thrown.length === 4 && thrown.every((error, i) => error === expected[i])"), true);
  assert.deepEqual(p.reported(), ["play_rejected_not_allowed", "play_rejected_not_supported", "play_rejected_abort", "play_rejected_other"]);
});

test("a play() that works reports nothing and the page gets its value", async () => {
  const p = page();
  p.run("globalThis.value = null; const video = new HTMLMediaElement(); video.answer = () => Promise.resolve('started'); video.play().then((v) => { value = v; });");
  await settle();
  assert.equal(p.run("value"), "started");
  assert.deepEqual(p.reported(), []);
  assert.equal(p.run("(() => { const video = new HTMLMediaElement(); video.answer = () => undefined; return video.play(); })()"), undefined);
});

test("a media element's error code is reported, and nothing else that fails on the page is", () => {
  const p = page();
  p.run(`
    const fail = (code) => {
      const video = new HTMLMediaElement();
      video._error = code === null ? null : new MediaError(code);
      video.dispatchEvent(new Event("error"));
    };
    for (const code of [1, 2, 3, 4, 0, 5, null]) fail(code);
    new Node().dispatchEvent(new Event("error"));
  `);
  assert.deepEqual(p.reported(), ["media_error_aborted", "media_error_network", "media_error_decode", "media_error_src_not_supported"]);
});

test("an error on a media element the page played outside the document, like new Audio(), is reported once, before and after it is attached", () => {
  const p = page();
  p.run(`
    const audio = new HTMLMediaElement();
    audio._detached = true;
    audio.play();
    audio._error = new MediaError(3);
    audio.dispatchEvent(new Event("error"));
    audio._detached = false;
    audio._error = new MediaError(2);
    audio.dispatchEvent(new Event("error"));
    const unplayed = new HTMLMediaElement();
    unplayed._detached = true;
    unplayed._error = new MediaError(4);
    unplayed.dispatchEvent(new Event("error"));
  `);
  assert.deepEqual(p.reported(), ["media_error_decode", "media_error_network"]);
});

test("Safari's prefixed key system answers (once per page each) and session key errors are reported, as Spotify's player uses them, and the page gets its own answers", () => {
  const p = page();
  p.run(`
    globalThis.answers = ["com.apple.fps", "com.apple.fps.1_0", "com.widevine.alpha", "org.w3.clearkey", "com.apple.fps", "com.widevine.alpha"].map((name) => WebKitMediaKeys.isTypeSupported(name, "video/mp4"));
    const session = new WebKitMediaKeys("com.apple.fps").createSession("video/mp4", new Uint8Array(1));
    globalThis.isSession = session instanceof WebKitMediaKeySession;
    for (const code of [4, 2, 9, null]) {
      session._error = code === null ? null : new WebKitMediaKeyError(code);
      session.dispatchEvent(new Event("webkitkeyerror"));
    }
  `);
  assert.deepEqual(p.json("answers"), [true, false, false, false, true, false]);
  assert.equal(p.json("isSession"), true);
  assert.deepEqual(p.reported(), ["eme_fairplay_legacy_supported", "eme_fairplay_legacy_unsupported", "eme_widevine_legacy_unsupported", "eme_other_legacy_unsupported", "eme_legacy_key_error_output", "eme_legacy_key_error_client"]);
  assert.ok(p.reported().every((reason) => reasons.includes(reason)));
});

test("a fault the page keeps raising is reported 20 times, not without end", async () => {
  const p = page();
  p.run("const video = new HTMLMediaElement(); video.answer = () => Promise.reject(new DOMException('', 'NotAllowedError')); for (let i = 0; i < 30; i++) video.play().catch(() => {});");
  await settle();
  assert.equal(p.reported().length, 20);
});

test("nothing is wrapped or reported off the streaming sites, over http or on a look-alike host", async () => {
  const hosts = [
    ["https:", "example.com"],
    ["https:", `not${sites[0]}`],
    ["https:", `${sites[0]}.example.com`],
    ["http:", sites[0]],
  ];
  for (const [protocol, hostname] of hosts) {
    const p = page({ protocol, hostname });
    assert.equal(p.run("Navigator.prototype.requestMediaKeySystemAccess === originalAccess && HTMLMediaElement.prototype.play !== originalPlay"), true, hostname);
    p.run(`
      navigator.answer = () => Promise.reject(new DOMException("no CDM", "NotSupportedError"));
      navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{}]).catch(() => {});
      const video = new HTMLMediaElement();
      video.answer = () => Promise.reject(new DOMException("", "NotAllowedError"));
      video.play().catch(() => {});
      video._error = new MediaError(3);
      video.dispatchEvent(new Event("error"));
    `);
    await settle();
    assert.deepEqual(p.reported(), [], `${protocol}//${hostname}`);
  }
});

test("a subdomain of a streaming site is watched", async () => {
  const p = page({ hostname: `www.${sites[0]}` });
  p.run("navigator.answer = () => Promise.resolve({}); navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{}]);");
  await settle();
  assert.deepEqual(p.reported(), ["eme_widevine_granted"]);
});

test("the page script relays a reason that is a short string and nothing else the page's events carry", () => {
  const p = page();
  p.run(`
    for (const detail of ["media_error_decode", 42, null, { reason: "x" }, ["a"], "x".repeat(65), "x".repeat(64)]) document.dispatchEvent(new CustomEvent("ardia:media-fault", { detail }));
  `);
  assert.deepEqual(p.reported(), ["media_error_decode", "x".repeat(64)]);
  assert.ok(p.faults().every((m) => Object.keys(m.data).join() === "reason"));
});

test("the page script relays at most 200 reasons per page", () => {
  const p = page();
  p.run(`for (let i = 0; i < 300; i++) document.dispatchEvent(new CustomEvent("ardia:media-fault", { detail: "media_error_decode" }));`);
  assert.equal(p.reported().length, 200);
});

test("a page off the streaming sites gets no media fault listener or wrapper", () => {
  for (const [protocol, hostname] of [["https:", "example.com"], ["http:", sites[0]], ["https:", `not${sites[0]}`]]) {
    const p = page({ protocol, hostname });
    assert.equal(p.json("(document._listeners || []).filter((l) => l.type === 'ardia:media-fault' || l.type === 'error').length"), 0, `${protocol}//${hostname}`);
    assert.equal(p.json("Navigator.prototype.requestMediaKeySystemAccess === originalAccess && WebKitMediaKeys.isTypeSupported === originalIsTypeSupported && WebKitMediaKeys.prototype.createSession === originalCreateSession"), true);
    p.run(`document.dispatchEvent(new CustomEvent("ardia:media-fault", { detail: "media_error_decode" }));`);
    assert.deepEqual(p.reported(), [], `${protocol}//${hostname}`);
  }
});

test("a refused protected key system request is passed on as a drm diagnostic with its host-free key system and error code, and the page still gets the refusal", async () => {
  const p = page();
  p.run(`
    const refusal = new DOMException("no CDM", "NotSupportedError");
    refusal._code = 9;
    globalThis.refusal = refusal;
    globalThis.thrown = [];
    navigator.answer = () => Promise.reject(refusal);
    for (let i = 0; i < 2; i++) navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{}]).catch((error) => thrown.push(error));
  `);
  await settle();
  assert.equal(p.run("thrown.length === 2 && thrown.every((error) => error === refusal)"), true);
  assert.deepEqual(p.drm(), [{ stage: "accessDenied", keySystem: "com.widevine.alpha", code: 9 }]);
  assert.deepEqual(p.reported(), ["eme_widevine_refused_not_supported", "eme_widevine_refused_not_supported"]);
});

test("a granted protected key system request is passed on as a drm diagnostic and the page gets its own result", async () => {
  const p = page();
  p.run(`
    globalThis.access = { keySystem: "com.microsoft.playready" };
    navigator.answer = () => Promise.resolve(access);
    navigator.requestMediaKeySystemAccess("com.microsoft.playready", [{}]).then((value) => { globalThis.got = value; });
  `);
  await settle();
  assert.equal(p.run("got === access"), true);
  assert.deepEqual(p.drm(), [{ stage: "access", keySystem: "com.microsoft.playready", code: 0 }]);
});

test("a key system that isn't Widevine, PlayReady or FairPlay, and a request that doesn't return a promise, send no drm diagnostic", async () => {
  const p = page();
  p.run(`
    navigator.answer = () => Promise.reject(new DOMException("no", "NotSupportedError"));
    navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{}]).catch(() => {});
    navigator.requestMediaKeySystemAccess(42, [{}]).catch(() => {});
  `);
  await settle();
  assert.deepEqual(p.drm(), []);
  assert.equal(p.run("navigator.answer = () => 7; navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{}])"), 7);
  assert.deepEqual(p.drm(), []);
});

test("encrypted, waitingforkey and media error codes are passed on once each from media elements only, with the key system the page asked for", async () => {
  const p = page();
  p.run(`
    navigator.answer = () => Promise.resolve({});
    navigator.requestMediaKeySystemAccess("com.apple.fps.1_0", [{}]);
  `);
  await settle();
  p.run(`
    const video = new HTMLMediaElement();
    video.dispatchEvent(new Event("encrypted"));
    video.dispatchEvent(new Event("waitingforkey"));
    video.dispatchEvent(new Event("waitingforkey"));
    video._error = new MediaError(4);
    video.dispatchEvent(new Event("error"));
    video._error = null;
    video.dispatchEvent(new Event("error"));
    new Node().dispatchEvent(new Event("encrypted"));
    new Node().dispatchEvent(new Event("error"));
  `);
  assert.deepEqual(p.drm(), [
    { stage: "access", keySystem: "com.apple.fps.1_0", code: 0 },
    { stage: "encrypted", keySystem: "com.apple.fps.1_0", code: 0 },
    { stage: "waitingforkey", keySystem: "com.apple.fps.1_0", code: 0 },
    { stage: "error", keySystem: "com.apple.fps.1_0", code: 4 },
    { stage: "error", keySystem: "com.apple.fps.1_0", code: 0 },
  ]);
});

test("at most 16 distinct drm diagnostics leave a frame", () => {
  const p = page();
  p.run(`
    for (let code = 1; code <= 40; code++) {
      const video = new HTMLMediaElement();
      video._error = new MediaError(code);
      video.dispatchEvent(new Event("error"));
    }
  `);
  assert.equal(p.drm().length, 16);
});

test("a page off the streaming sites sends no drm diagnostic for a key system request or a media element", async () => {
  const p = page({ hostname: "example.com" });
  p.run(`
    const refusal = new DOMException("no CDM", "NotSupportedError");
    refusal._code = 9;
    navigator.answer = () => Promise.reject(refusal);
    navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{}]).catch(() => {});
    const video = new HTMLMediaElement();
    video.dispatchEvent(new Event("encrypted"));
    video._error = new MediaError(4);
    video.dispatchEvent(new Event("error"));
  `);
  await settle();
  assert.deepEqual(p.drm(), []);
});
