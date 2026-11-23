import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInContext, runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const script = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("  const passkeysOn = true;\n  try {\n");
const end = script.indexOf("\n  } catch (e) {}\n", start);
assert.ok(start > 0 && end > start, "page_script.js has the passkey block");
const block = script.slice(start, end + "\n  } catch (e) {}\n".length);

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const plain = (value) => JSON.parse(JSON.stringify(value));

function makePage({ top = true, on = true, late = false } = {}) {
  const posted = [];
  const originals = { create: [], get: [] };
  const clock = { timers: [], seq: 0 };
  const listeners = [];
  const handlers = Object.create(null);
  const illegal = () => {
    throw new TypeError("Illegal invocation");
  };
  class PublicKeyCredential {}
  for (const name of ["id", "rawId", "type", "response", "authenticatorAttachment"]) Object.defineProperty(PublicKeyCredential.prototype, name, { get: illegal, configurable: true });
  PublicKeyCredential.prototype.getClientExtensionResults = illegal;
  PublicKeyCredential.prototype.toJSON = illegal;
  PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
  class AuthenticatorResponse {}
  Object.defineProperty(AuthenticatorResponse.prototype, "clientDataJSON", { get: illegal, configurable: true });
  class AuthenticatorAttestationResponse extends AuthenticatorResponse {}
  class AuthenticatorAssertionResponse extends AuthenticatorResponse {}
  class CredentialsContainer {
    create(options) {
      originals.create.push({ self: this, options });
      return Promise.resolve("chrome-create");
    }
    get(options) {
      originals.get.push({ self: this, options });
      return Promise.resolve("chrome-get");
    }
  }
  const credentials = new CredentialsContainer();
  const nativeCreate = CredentialsContainer.prototype.create;
  const classes = { PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse };
  const window = {
    ...(late ? {} : classes),
    CredentialsContainer,
    AbortSignal,
    DataView,
    crypto: webcrypto,
    btoa,
    atob,
    setTimeout: (fn, ms) => {
      const id = ++clock.seq;
      clock.timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      clock.timers = clock.timers.filter((t) => t.id !== id);
    },
  };
  const realListen = EventTarget.prototype.addEventListener;
  const context = {
    window,
    navigator: { credentials },
    document: { addEventListener: (type, fn) => listeners.push({ type, fn }) },
    guard: (fn) => (...args) => {
      try {
        return fn(...args);
      } catch (e) {}
    },
    isTop: top,
    Promise,
    DOMException,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Map,
    Object,
    Array,
    String,
    TypeError,
    AbortSignal,
    EventTarget: {
      prototype: {
        addEventListener(type, fn, options) {
          if (this === window) return listeners.push({ type, fn });
          return Reflect.apply(realListen, this, [type, fn, options]);
        },
        removeEventListener(type, fn) {
          return Reflect.apply(EventTarget.prototype.removeEventListener, this, [type, fn]);
        },
      },
    },
    Reflect,
    apply: Reflect.apply,
    handlers,
    asNative: (native, call) => new Proxy(native, { apply: (target, self, args) => call(target, self, args) }),
    serialize: (data) => JSON.stringify(data),
    send: (kind, data) => posted.push({ kind, data: JSON.parse(JSON.stringify(data)) }),
    post: (kind, json) => posted.push({ kind, data: JSON.parse(json) }),
  };
  context.globalThis = context;
  const code = on ? block : block.replace("const passkeysOn = true;", "const passkeysOn = false;");
  runInNewContext(code, context);
  const answer = (message) => handlers.passkey && handlers.passkey(JSON.parse(JSON.stringify(message)));
  const tick = (ms) => {
    const due = clock.timers.filter((t) => t.ms <= ms);
    clock.timers = clock.timers.filter((t) => t.ms > ms);
    for (const t of due) t.fn();
  };
  const fire = (type) => {
    for (const l of listeners) if (l.type === type) l.fn({ type });
  };
  const arrive = () => Object.assign(window, classes);
  const extension = (id, source) => runInContext(source, context, { filename: `chrome-extension://${id}/webauthn.js` });
  return { window, credentials, posted, originals, answer, tick, fire, handlers, context, CredentialsContainer, arrive, nativeCreate, extension };
}

const createOptions = (extra = {}) => ({
  publicKey: {
    challenge: new Uint8Array([1, 2, 3, 4]),
    rp: { id: "example.com", name: "Example" },
    user: { id: new Uint8Array([9, 8, 7]).buffer, name: "alice@example.com", displayName: "Alice" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ type: "public-key", id: new DataView(new Uint8Array([5, 6]).buffer) }],
    extensions: { credProps: true, prf: {} },
    ...extra,
  },
});

test("off or in a subframe, nothing is wrapped", () => {
  for (const page of [makePage({ on: false }), makePage({ top: false })]) {
    assert.equal(page.credentials.create, page.nativeCreate);
    assert.equal(page.handlers.passkey, undefined);
  }
});

test("create sends plain options and resolves a PublicKeyCredential-shaped object", async () => {
  const page = makePage();
  const pending = page.credentials.create(createOptions());
  const sent = page.posted.find((p) => p.kind === "passkeyCreate");
  assert.ok(sent, "posted passkeyCreate");
  assert.equal(sent.data.options.challenge, b64url([1, 2, 3, 4]));
  assert.equal(sent.data.options.user.id, b64url([9, 8, 7]));
  assert.equal(sent.data.options.excludeCredentials[0].id, b64url([5, 6]));
  assert.equal(sent.data.options.rp.id, "example.com");
  assert.deepEqual(sent.data.options.extensions, { credProps: true });
  assert.match(sent.data.id, /^[0-9a-f]{32}$/);
  page.answer({ id: sent.data.id, ack: true });
  page.answer({
    id: sent.data.id,
    credential: {
      kind: "create",
      id: b64url([1, 1, 2, 2]),
      clientDataJSON: b64url(Buffer.from('{"type":"webauthn.create"}')),
      attestationObject: b64url([0xa3]),
      authenticatorData: b64url([7, 7]),
      publicKey: b64url([0x30, 1]),
      publicKeyAlgorithm: -7,
      transports: ["internal"],
      extensions: { credProps: { rk: true } },
    },
  });
  const credential = await pending;
  assert.ok(credential instanceof page.window.PublicKeyCredential);
  assert.ok(credential.response instanceof page.window.AuthenticatorAttestationResponse);
  assert.equal(credential.id, b64url([1, 1, 2, 2]));
  assert.deepEqual([...new Uint8Array(credential.rawId)], [1, 1, 2, 2]);
  assert.equal(credential.type, "public-key");
  assert.equal(credential.authenticatorAttachment, "platform");
  assert.equal(Buffer.from(credential.response.clientDataJSON).toString(), '{"type":"webauthn.create"}');
  assert.deepEqual([...new Uint8Array(credential.response.attestationObject)], [0xa3]);
  assert.deepEqual(plain(credential.response.getTransports()), ["internal"]);
  assert.deepEqual([...new Uint8Array(credential.response.getAuthenticatorData())], [7, 7]);
  assert.deepEqual([...new Uint8Array(credential.response.getPublicKey())], [0x30, 1]);
  assert.equal(credential.response.getPublicKeyAlgorithm(), -7);
  assert.deepEqual(plain(credential.getClientExtensionResults()), { credProps: { rk: true } });
  const json = credential.toJSON();
  assert.equal(json.rawId, credential.id);
  assert.equal(json.response.attestationObject, b64url([0xa3]));
  assert.equal(json.response.publicKeyAlgorithm, -7);
  assert.deepEqual(plain(json.clientExtensionResults), { credProps: { rk: true } });
  assert.equal(page.originals.create.length, 0, "Chrome wasn't asked");
});

test("get resolves an assertion with a user handle", async () => {
  const page = makePage();
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([3]), rpId: "example.com", allowCredentials: [] }, mediation: "conditional" });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  assert.equal(sent.data.mediation, "conditional");
  assert.equal(sent.data.options.rpId, "example.com");
  page.answer({ id: sent.data.id, ack: true });
  page.tick(10_000);
  page.answer({
    id: sent.data.id,
    credential: { kind: "get", id: "AQI", clientDataJSON: "e30", authenticatorData: "AAE", signature: "MEU", userHandle: "CQg" },
  });
  const credential = await pending;
  assert.ok(credential.response instanceof page.window.AuthenticatorAssertionResponse);
  assert.deepEqual([...new Uint8Array(credential.response.userHandle)], [9, 8]);
  assert.deepEqual([...new Uint8Array(credential.response.signature)], [0x30, 0x45]);
  assert.equal(credential.toJSON().response.userHandle, "CQg");
  assert.deepEqual(plain(credential.getClientExtensionResults()), {});
});

test("fallback hands the page's own options to Chrome", async () => {
  const page = makePage();
  const options = createOptions();
  const pending = page.credentials.create(options);
  const sent = page.posted.find((p) => p.kind === "passkeyCreate");
  page.answer({ id: sent.data.id, fallback: true });
  assert.equal(await pending, "chrome-create");
  assert.equal(page.originals.create[0].options, options);
  assert.equal(page.originals.create[0].self, page.credentials);
});

test("no answer from native in time falls back to Chrome", async () => {
  const page = makePage();
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  page.tick(3000);
  assert.equal(await pending, "chrome-get");
});

test("errors map to DOMExceptions", async () => {
  for (const [error, name] of [["NotAllowedError", "NotAllowedError"], ["InvalidStateError", "InvalidStateError"], ["SomethingElse", "NotAllowedError"]]) {
    const page = makePage();
    const pending = page.credentials.create(createOptions());
    const sent = page.posted.find((p) => p.kind === "passkeyCreate");
    page.answer({ id: sent.data.id, error });
    await assert.rejects(pending, (e) => e instanceof DOMException && e.name === name);
  }
});

test("answers are matched by id and read from own properties only", async () => {
  const page = makePage();
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.answer({ id: "someone-else", fallback: true });
  Object.defineProperty(Object.prototype, "fallback", { get: () => true, configurable: true });
  Object.defineProperty(Object.prototype, "error", { get: () => "InvalidStateError", configurable: true });
  try {
    page.handlers.passkey({ id: sent.data.id, credential: { kind: "get", id: "AQ", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA", userHandle: "AA" } });
  } finally {
    delete Object.prototype.fallback;
    delete Object.prototype.error;
  }
  const credential = await pending;
  assert.equal(credential.id, "AQ");
  assert.equal(page.originals.get.length, 0);
});

test("non-WebAuthn calls, odd receivers and bad options go straight to Chrome", async () => {
  const page = makePage();
  assert.equal(await page.credentials.get({ password: true }), "chrome-get");
  assert.equal(await page.credentials.get(), "chrome-get");
  assert.equal(await page.credentials.create.call({}, createOptions()), "chrome-create");
  assert.equal(await page.credentials.create(createOptions({ rp: { id: 5, name: "x" } })), "chrome-create");
  assert.equal(await page.credentials.get({ publicKey: { challenge: "not bytes" } }), "chrome-get");
  assert.equal(await page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, mediation: 7 }), "chrome-get");
  assert.equal(page.posted.length, 0);
});

test("an already aborted signal goes to Chrome; aborting later rejects and tells native", async () => {
  const page = makePage();
  const early = new AbortController();
  early.abort();
  assert.equal(await page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, signal: early.signal }), "chrome-get");
  const later = new AbortController();
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, signal: later.signal, mediation: "conditional" });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  later.abort(new Error("page aborted"));
  await assert.rejects(pending, /page aborted/);
  assert.ok(page.posted.some((p) => p.kind === "passkeyCancel" && p.data.id === sent.data.id));
  page.answer({ id: sent.data.id, credential: { kind: "get", id: "AQ" } });
});

test("a page whose options getters change between reads is held to what was read first", async () => {
  const page = makePage();
  const live = new AbortController();
  const gone = new AbortController();
  gone.abort();
  const reads = { signal: 0, mediation: 0 };
  const options = {
    publicKey: { challenge: new Uint8Array([1]) },
    get signal() {
      return reads.signal++ ? gone.signal : live.signal;
    },
    get mediation() {
      return reads.mediation++ ? "conditional" : undefined;
    },
  };
  const pending = page.credentials.get(options);
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  assert.equal(sent.data.mediation, undefined);
  assert.deepEqual(reads, { signal: 1, mediation: 1 });
  live.abort(new Error("page aborted"));
  const settled = await Promise.race([pending.then(() => "resolved", (e) => e.message), Promise.resolve().then(() => "pending")]);
  assert.equal(settled, "page aborted");
});

test("a message over the channel's limit falls back without posting", async () => {
  const page = makePage();
  const big = Array.from({ length: 64 }, () => ({ type: "public-key", id: new Uint8Array(1000) }));
  assert.equal(await page.credentials.get({ publicKey: { challenge: new Uint8Array([1]), allowCredentials: big } }), "chrome-get");
  assert.equal(page.posted.length, 0);
});

test("leaving the page rejects what's pending", async () => {
  const page = makePage();
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, mediation: "conditional" });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.fire("pagehide");
  await assert.rejects(pending, (e) => e.name === "AbortError");
  assert.ok(page.posted.some((p) => p.kind === "passkeyCancel" && p.data.id === sent.data.id));
});

test("the platform authenticator and conditional mediation report available", async () => {
  const page = makePage();
  assert.equal(await page.window.PublicKeyCredential.isConditionalMediationAvailable(), true);
  assert.equal(await page.window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true);
});

test("PublicKeyCredential that appears after install still gets the wrapper's statics and results", async () => {
  const page = makePage({ late: true });
  assert.notEqual(page.credentials.create, page.nativeCreate, "create and get are wrapped at install");
  page.arrive();
  page.tick(0);
  assert.equal(await page.window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true);
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.answer({ id: sent.data.id, credential: { kind: "get", id: "AQ", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA", userHandle: "AA" } });
  assert.ok((await pending) instanceof page.window.PublicKeyCredential);
});

test("a modal request native acked but never answered rejects instead of hanging", async () => {
  const page = makePage();
  const pending = page.credentials.create(createOptions());
  const sent = page.posted.find((p) => p.kind === "passkeyCreate");
  page.answer({ id: sent.data.id, ack: true });
  page.tick(3000);
  page.tick(630000);
  await assert.rejects(pending, (e) => e.name === "NotAllowedError");
  assert.ok(page.posted.some((p) => p.kind === "passkeyCancel" && p.data.id === sent.data.id));
  assert.equal(page.originals.create.length, 0);
});

const PROTON = "ghmbeldphafepmbegfdlkpapadhbakde";
const OTHER = "nngceckbapebfimnlniiiahkandclblb";
const installAs = (page, id, tag) =>
  page.extension(
    id,
    `(() => {
      const store = navigator.credentials;
      const original = { create: store.create.bind(store), get: store.get.bind(store) };
      globalThis.calls_${tag} = [];
      store.get = function ${tag}Get(options) {
        globalThis.calls_${tag}.push(options);
        return globalThis.decline_${tag} ? original.get(options) : Promise.resolve("${tag}-get");
      };
      store.create = function ${tag}Create(options) {
        globalThis.calls_${tag}.push(options);
        return Promise.resolve("${tag}-create");
      };
      globalThis.restore_${tag} = () => { store.get = original.get; store.create = original.create; };
    })()`,
  );

test("an extension's own assignment is recorded, attributed by its script, and doesn't replace Ardia's wrapper", () => {
  const page = makePage();
  const wrapper = page.credentials.get;
  installAs(page, PROTON, "proton");
  assert.equal(page.credentials.get, wrapper, "the page still calls Ardia's wrapper first");
  assert.equal(Object.getOwnPropertyDescriptor(page.credentials, "get"), undefined, "no own property shadows the prototype");
  void page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  assert.deepEqual(sent.data.extensions, [PROTON]);
});

test("native can route to a named extension, and that extension's own fallback reaches Chrome, not Ardia again", async () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  installAs(page, OTHER, "other");
  const options = { publicKey: { challenge: new Uint8Array([1]) } };
  const pending = page.credentials.get(options);
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  assert.deepEqual(sent.data.extensions, [PROTON, OTHER]);
  page.answer({ id: sent.data.id, extension: PROTON });
  assert.equal(await pending, "proton-get");
  assert.equal(page.context.calls_proton[0], options, "the extension gets the page's own options");
  assert.equal(page.context.calls_other.length, 0);
  void page.credentials.get(options);
  assert.equal(page.posted.filter((p) => p.kind === "passkeyGet").length, 2, "once the hand-off settled, a retry with the same options is a new request");
});

test("a hand-off that throws rejects the page's promise instead of leaving it hanging", async () => {
  const page = makePage();
  page.extension(PROTON, "navigator.credentials.get = function brokenGet() { throw new Error('extension broke'); };");
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.answer({ id: sent.data.id, extension: PROTON });
  await assert.rejects(pending, /extension broke/);
});

test("the first function an extension registers stays; a page forging that extension later can't replace it", () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  page.extension(PROTON, "navigator.credentials.get = function forged() { return 'forged'; };");
  void page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.answer({ id: sent.data.id, extension: PROTON });
  assert.equal(page.context.calls_proton.length, 1);
});

test("only the frame that called the setter counts, so an extension higher up the stack isn't credited", () => {
  const page = makePage();
  page.extension(OTHER, "globalThis.runForPage = (fn) => fn();");
  page.context.runForPage(() => {
    page.credentials.create = function pageOwn() {};
  });
  assert.equal(typeof Object.getOwnPropertyDescriptor(page.credentials, "create")?.value, "function", "the page's own assignment stays the page's");
});

test("an extension that declines a request Ardia handed it falls through to Chrome", async () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  page.context.decline_proton = true;
  const pending = page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  const sent = page.posted.find((p) => p.kind === "passkeyGet");
  page.answer({ id: sent.data.id, extension: PROTON });
  assert.equal(await pending, "chrome-get");
  assert.equal(page.posted.filter((p) => p.kind === "passkeyGet").length, 1);
});

test("fallback means as if Ardia weren't there: the extension that installed last answers; chrome means Chrome", async () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  installAs(page, OTHER, "other");
  const first = page.credentials.create(createOptions());
  page.answer({ id: page.posted.filter((p) => p.kind === "passkeyCreate")[0].data.id, fallback: true });
  assert.equal(await first, "other-create");
  const second = page.credentials.create(createOptions());
  page.answer({ id: page.posted.filter((p) => p.kind === "passkeyCreate")[1].data.id, chrome: true });
  assert.equal(await second, "chrome-create");
  assert.equal(page.originals.create.length, 1);
});

test("calls Ardia doesn't take go to the extension, as without Ardia", async () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  assert.equal(await page.credentials.get({ password: true }), "proton-get");
  assert.equal(await page.credentials.get({ publicKey: { challenge: "not bytes" } }), "proton-get");
  assert.equal(page.posted.length, 0);
});

test("an extension putting back its bound original leaves the race, and a page's own override behaves natively", async () => {
  const page = makePage();
  installAs(page, PROTON, "proton");
  page.context.restore_proton();
  void page.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  assert.deepEqual(page.posted.find((p) => p.kind === "passkeyGet").data.extensions, []);
  const mine = () => "page-own";
  page.credentials.create = mine;
  assert.equal(page.credentials.create, mine, "a page's assignment shadows like a normal property");
});
