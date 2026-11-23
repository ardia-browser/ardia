import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const { createCredentialRuntime, pageItems } = await import("./credentialRuntime.ts");
const { CredentialError, SignIn, verbs } = await import("./credentialErrors.ts");
const { base64url, origins, uuids, json } = await import("./credentialData.ts");
const { totp } = await import("./totp.ts");
const { CREDENTIAL_LIMITS, CREDENTIALS_PROTOCOL } = await import("./credentialConstants.ts");
const entry = await import("./credentials.ts");
const index = await import("./index.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function host({ supported = [1] } = {}) {
  const sent = [];
  let listener = () => {};
  const transport = { send: (line) => sent.push(JSON.parse(line)), onLine: (l) => (listener = l) };
  const errors = [];
  const runtime = createCredentialRuntime(transport, { now: () => 1_000, onError: (e) => errors.push(e) });
  const push = (message) => listener(JSON.stringify(message));
  const answerHandshake = async () => {
    await tick();
    const hello = sent.find((m) => m.method === "hello");
    push({ id: hello.id, result: { app: "Ardia", protocol: 2, credentials: { protocol: 1, supported, provider: "p" } } });
    await tick();
    const ready = sent.find((m) => m.method === "ready");
    if (ready) push({ id: ready.id, result: { ok: true } });
    await tick();
  };
  let calls = 0;
  const call = (name, input = {}, context = {}) => {
    const id = `v${++calls}`;
    push({ call: id, kind: "credentials", name, input, deadline: 1000, context });
    return id;
  };
  const results = () => sent.filter((m) => m.method === "result");
  const requests = (method) => sent.filter((m) => m.method === method);
  return { sent, push, runtime, answerHandshake, call, results, requests, errors };
}

const minimal = (extra = {}) => ({
  state: () => ({ state: "unlocked" }),
  signIn: () => SignIn.done(),
  unlock: () => SignIn.done(),
  signOut: () => undefined,
  list: () => [],
  reveal: () => ({}),
  ...extra,
});

test("hello names the credentials protocol and ready lists the handlers the provider has", async () => {
  const h = host();
  void h.runtime.define(minimal({ save: () => ({}), passkeys: { get: () => null, save: () => ({ item: "x" }) } }));
  await h.answerHandshake();
  assert.deepEqual(h.requests("hello")[0].params, { protocol: 2, sdk: "2.1.0", credentials: CREDENTIALS_PROTOCOL });
  assert.deepEqual(h.requests("ready")[0].params.credentialProvider.handlers, ["state", "signIn", "unlock", "signOut", "list", "reveal", "save", "passkeys.get", "passkeys.save"]);
});

test("a host that doesn't support the protocol gets no ready, and calls go unanswered", async () => {
  const h = host({ supported: [9] });
  void h.runtime.define(minimal());
  await h.answerHandshake();
  assert.equal(h.requests("ready").length, 0);
  h.call("state");
  await tick();
  assert.equal(h.results().length, 0);
  assert.match(String(h.errors[0]?.message), /credentials protocol 1/);
});

test("results go back by call id; thrown errors become wire errors and undefined becomes null", async () => {
  const h = host();
  void h.runtime.define(minimal({ reveal: () => { throw CredentialError.failed("unreadable", { detail: "line one\nline two" }); }, signOut: () => undefined, state: () => { throw new Error("boom"); } }));
  await h.answerHandshake();
  h.push({ call: "v1", kind: "credentials", name: "reveal", input: { id: "a", fields: ["password"] }, context: {} });
  h.push({ call: "v2", kind: "credentials", name: "signOut", input: {}, context: {} });
  h.push({ call: "v3", kind: "credentials", name: "state", input: {}, context: {} });
  h.push({ call: "v4", kind: "credentials", name: "addTotp", input: {}, context: {} });
  await tick();
  await tick();
  const by = Object.fromEntries(h.results().map((m) => [m.params.call, m.params]));
  assert.deepEqual(by.v1.error, { code: "failed", problem: "unreadable", detail: "line one" });
  assert.equal(by.v2.result, null);
  assert.deepEqual(by.v3.error, { code: "failed", problem: "failed", detail: "boom" });
  assert.deepEqual(by.v4.error, { code: "unsupported" });
});

test("a plain array listing pages by encoded size, and later pages come from the held snapshot", async () => {
  const items = Array.from({ length: 3000 }, (_, i) => ({ id: `item-${i}`, title: "t".repeat(800), username: "u", urls: [] }));
  let asked = 0;
  const h = host();
  void h.runtime.define(minimal({ list: () => (asked++, items) }));
  await h.answerHandshake();
  const seen = [];
  let request = { snapshot: null, cursor: null };
  for (let i = 0; i < 10; i++) {
    h.push({ call: `l${i}`, kind: "credentials", name: "list", input: request, context: {} });
    await tick();
    await tick();
    const page = h.results().at(-1).params.result;
    assert.ok(JSON.stringify(page).length <= CREDENTIAL_LIMITS.resultBytes);
    seen.push(...page.items);
    if (!page.cursor) break;
    request = { snapshot: page.snapshot, cursor: page.cursor };
  }
  assert.equal(asked, 1);
  assert.deepEqual(seen.map((i) => i.id), items.map((i) => i.id));
  assert.ok(pageItems(items).length > 2);
});

test("verb notices route to their request: items, stream lines and json parts", async () => {
  const h = host();
  const got = { items: [], lines: [] };
  let result;
  void h.runtime.define(minimal({
    list: async (_i, ctx) => {
      const listed = await ctx.cli.verb("list.items", { session: { $secret: "h1" } }, { onItem: (item) => got.items.push(item), onLine: (line) => got.lines.push(line) });
      result = listed;
      return [];
    },
  }));
  await h.answerHandshake();
  const id = h.call("list", { snapshot: null, cursor: null });
  await tick();
  await tick();
  const verb = h.requests("credentials.verb")[0];
  assert.deepEqual(verb.params, { call: id, verb: "list.items", params: { session: { $secret: "h1" } } });
  h.push({ verbOf: verb.id, item: { id: 1 }, index: 0 });
  h.push({ verbOf: verb.id, line: { stream: "stderr", text: "hi" } });
  h.push({ verbOf: verb.id, part: '{"a":' });
  h.push({ verbOf: verb.id, part: "[1,2]}" });
  h.push({ id: verb.id, result: { status: 0, launched: true, succeeded: true, items: 1, json: null } });
  await tick();
  await tick();
  assert.deepEqual(got, { items: [{ id: 1 }], lines: [{ stream: "stderr", text: "hi" }] });
  assert.deepEqual(result.json, { a: [1, 2] });
  assert.equal(result.succeeded, true);
});

test("a throwing onItem fails the verb with that error", async () => {
  const h = host();
  void h.runtime.define(minimal({ list: async (_i, ctx) => (await ctx.cli.verb("x", {}, { onItem: () => { throw CredentialError.failed("unreadable"); } }), []) }));
  await h.answerHandshake();
  h.call("list", { snapshot: null, cursor: null });
  await tick();
  await tick();
  const verb = h.requests("credentials.verb")[0];
  h.push({ verbOf: verb.id, item: {}, index: 0 });
  h.push({ id: verb.id, result: { status: 0, succeeded: true } });
  await tick();
  await tick();
  assert.deepEqual(h.results().at(-1).params.error, { code: "failed", problem: "unreadable" });
});

test("a stale request error is the lock it is, and a context used after its call ended is closed", async () => {
  const h = host();
  let kept;
  void h.runtime.define(minimal({ state: async (_i, ctx) => ((kept = ctx), await ctx.scratch.set("k", "v"), { state: "unlocked" }), reveal: async (_i, ctx) => (await ctx.cli.verb("get"), {}) }));
  await h.answerHandshake();
  h.call("reveal", { id: "a", fields: [] });
  await tick();
  await tick();
  const verb = h.requests("credentials.verb")[0];
  h.push({ id: verb.id, error: { code: "stale", message: "locked" } });
  await tick();
  await tick();
  assert.deepEqual(h.results().at(-1).params.error, { code: "locked" });
  h.call("state");
  await tick();
  await tick();
  const set = h.requests("credentials.values.set")[0];
  h.push({ id: set.id, result: { ok: true } });
  await tick();
  await tick();
  assert.equal(kept.scratch.get("k"), "v");
  await assert.rejects(() => kept.owner.confirm("x"), (error) => error.code === "closed");
});

test("a host cancel signals the handler and no result is sent", async () => {
  const h = host();
  let signal;
  void h.runtime.define(minimal({ state: (_i, ctx) => ((signal = ctx.signal), new Promise((resolve) => ctx.signal.onCancel(() => resolve({ state: "locked" })))) }));
  await h.answerHandshake();
  h.push({ call: "c1", kind: "credentials", name: "state", input: {}, context: {} });
  await tick();
  assert.equal(h.runtime.callCount(), 1);
  h.push({ call: "c1", cancel: true });
  await tick();
  await tick();
  assert.equal(signal.cancelled, true);
  assert.equal(h.results().length, 0);
  assert.equal(h.runtime.callCount(), 0);
});

test("the slim entry and the main index export the same credentials API", () => {
  for (const name of ["defineCredentialProvider", "CredentialError", "SignIn", "verbs", "json", "origins", "totp", "base64url", "uuids", "isSecretHandle", "credentialHandlersOf", "CREDENTIAL_LIMITS", "CREDENTIALS_PROTOCOL", "PluginError"]) {
    assert.ok(entry[name], name);
    assert.equal(index[name], entry[name], name);
  }
});

test("SignIn and CredentialError wire shapes leave out what isn't set", () => {
  assert.deepEqual(SignIn.needs({ kind: "field", field: "code" }), { ok: false, need: { kind: "field", field: "code" } });
  assert.deepEqual(SignIn.cancelled("locked"), { ok: false, problem: "cancelled", state: "locked" });
  assert.deepEqual(CredentialError.failed("failed", { detail: "x".repeat(400) }).toWire().detail.length, CREDENTIAL_LIMITS.detailLength);
});

test("verbs.check maps hints, launch failures and network words", () => {
  const result = (over) => ({ verb: "v", status: 1, launched: true, timedOut: false, cancelled: false, overflowed: false, succeeded: false, stderr: "", hints: [], json: null, lines: [], items: 0, droppedLines: 0, unlocked: false, ...over });
  const code = (r, offline = false) => { try { verbs.check(r, { locked: ["vault is locked"] }, offline); } catch (e) { return e.toWire(); } };
  assert.deepEqual(code(result({ stderr: "Vault is locked." })), { code: "locked" });
  assert.deepEqual(code(result({ launched: false })), { code: "failed", problem: "notLaunched" });
  assert.deepEqual(code(result({ stderr: "getaddrinfo ENOTFOUND" }), true), { code: "failed", problem: "offline" });
  assert.deepEqual(code(result({ stderr: "\u001b[31mError: no such item\u001b[0m" })), { code: "failed", problem: "failed", detail: "no such item" });
  assert.equal(code(result({ succeeded: true })), undefined);
});

const RFC_SECRETS = { SHA1: "12345678901234567890", SHA256: "12345678901234567890123456789012", SHA512: "1234567890123456789012345678901234567890123456789012345678901234" };
const RFC_CODES = { 59: ["94287082", "46119246", "90693936"], 1111111109: ["07081804", "68084774", "25091201"], 2000000000: ["69279037", "90698825", "38618901"] };

test("totp matches the RFC 6238 vectors for SHA1, SHA256 and SHA512", () => {
  for (const [seconds, codes] of Object.entries(RFC_CODES)) {
    ["SHA1", "SHA256", "SHA512"].forEach((algorithm, i) => {
      const secret = { secret: new TextEncoder().encode(RFC_SECRETS[algorithm]), period: 30, digits: 8, algorithm };
      assert.equal(totp.code(secret, Number(seconds) * 1000), codes[i], `${algorithm} at ${seconds}`);
    });
  }
});

test("totp parses otpauth URIs and plain secrets, refuses hotp, and compares by what generates the code", () => {
  const uri = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=60";
  assert.equal(totp.period(uri), 60);
  assert.equal(totp.parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP"), null);
  assert.equal(totp.parse("JBSW Y3DP EHPK 3PXP").digits, 6);
  assert.ok(totp.same(uri, "otpauth://totp/Other?issuer=Else&secret=jbswy3dpehpk3pxp&period=60"));
  assert.ok(!totp.same(uri, "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"));
  const steam = totp.parse("steam://JBSWY3DPEHPK3PXP");
  assert.match(totp.code(steam, 0), /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  const expected = createHmac("sha1", Buffer.from(totp.parse("JBSWY3DPEHPK3PXP").secret)).update(Buffer.alloc(8)).digest();
  const offset = expected[19] & 15;
  const value = ((expected.readUInt32BE(offset) & 0x7fffffff) % 1e6).toString().padStart(6, "0");
  assert.equal(totp.code(totp.parse("JBSWY3DPEHPK3PXP"), 0), value);
});

test("base64url and uuids round-trip; origins read hosts the way the host does", () => {
  const bytes = Uint8Array.from([0, 255, 62, 63, 1]);
  assert.equal(base64url.encode(bytes), "AP8-PwE");
  assert.deepEqual(base64url.decode("AP8-PwE"), bytes);
  assert.equal(base64url.decode("AP8-PwE", 4), null);
  assert.equal(base64url.decode("a+b"), null);
  assert.equal(uuids.string(uuids.bytes("11111111-2222-3333-4444-555555555555")), "11111111-2222-3333-4444-555555555555");
  assert.equal(origins.host("https://user@Vault.Example.com.:8443/x"), "vault.example.com");
  assert.ok(origins.hostIn("https://account.proton.me/a", ["proton.me"]));
  assert.ok(!origins.hostIn("https://evilproton.me/a", ["proton.me"]));
  assert.ok(!origins.isWebOrigin("https://a@b.com"));
  assert.ok(origins.isLocalHost("[::1]") && !origins.isLocalHost("localhost.example"));
  assert.equal(json.milliseconds(1_700_000_000), 1_700_000_000_000);
  assert.throws(() => json.list({}), (e) => e.problem === "unreadable");
});
