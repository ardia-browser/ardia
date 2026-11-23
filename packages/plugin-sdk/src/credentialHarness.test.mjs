import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const { effectiveTimeout } = await import("./verbLaunch.ts");
const { createCredentialHarness, buildVerb, buildVerbLaunch, checkCredentialManifest, readCredentialContribution } = await import("./testing.ts");
const { SignIn } = await import("./credentialErrors.ts");

const FIXTURE = new URL("../../ardiacore/tests/fixtures/credential-verbs.json", import.meta.url);

const PASSWORD = "fixture-pw-1";
const SESSION = "fixture-session-key-0001";
const secretSlot = { type: "secret" };

const manifest = () => ({
  manifest: 2,
  name: "fakevault",
  title: "Fake Vault",
  version: "1.0.0",
  official: true,
  main: "dist/main.js",
  contributes: {
    credentialProvider: {
      title: "Fake Vault",
      capabilities: ["save", "touchID", "masterPassword", "selfHosted"],
      signIn: {
        methods: [
          { id: "password", title: "Password", fields: [{ id: "email", title: "Email", type: "email" }, { id: "masterPassword", title: "Master Password", type: "secret" }] },
          { id: "browser", title: "Browser", kind: "browserApproval" },
        ],
        servers: [{ id: "us", title: "US" }, { id: "own", title: "Own", custom: { title: "Server URL" } }],
        unlock: { field: "masterPassword" },
        approvalHosts: ["example.com"],
      },
      cli: {
        name: "bw",
        install: { command: "brew install bw" },
        patterns: { guid: "^[0-9a-f-]{36}$" },
        env: [{ name: "FAKE_NOINTERACTION", literal: "true" }, { name: "FAKE_DATA", testFolder: "data" }, { name: "FAKE_KEYS", testLiteral: "fs" }],
        onLock: { verb: "lock", params: { session: { from: "session" } }, skipWithTouchID: true },
        verbs: {
          login: {
            argv: ["login", { slot: "email" }, "--raw", { flag: "--method", slot: "method" }, { flag: "--code", slot: "code" }],
            slots: { email: { type: "email" }, password: secretSlot, method: { type: "enum", values: ["0", "1"], optional: true }, code: { type: "code", optional: true } },
            env: [{ name: "FAKE_PASSWORD", secretSlot: "password" }],
            signIn: true,
            unlocks: { persistent: true },
            output: { mode: "lastLineSecret" },
            hints: { wrongCode: ["invalid code"] },
          },
          lock: { argv: ["lock"], slots: { session: { type: "secret", optional: true } }, env: [{ name: "FAKE_SESSION", secretSlot: "session" }], output: { mode: "lines" } },
          list: { argv: ["list", "items"], slots: { session: secretSlot }, env: [{ name: "FAKE_SESSION", secretSlot: "session" }], output: { mode: "json", items: "$" } },
          get: { argv: ["get", "item", { slot: "id" }], slots: { session: secretSlot, id: { type: "id", pattern: "guid" } }, env: [{ name: "FAKE_SESSION", secretSlot: "session" }], output: { mode: "json" } },
          create: { argv: ["create", "item"], slots: { session: secretSlot, item: { type: "json" } }, env: [{ name: "FAKE_SESSION", secretSlot: "session" }], stdin: { slot: "item", encoding: "base64" }, output: { mode: "json" } },
          server: { argv: ["config", "server", { slot: "url" }], slots: { url: { type: "url", allowLocalHttp: true } }, output: { mode: "lines" } },
          browser: { argv: ["login", "--browser"], signIn: true, unlocks: true, outlivesCall: true, output: { mode: "stream" }, hints: { extraPassword: ["extra password"] } },
          show: { argv: ["show", { flag: "--secrets", when: "secrets" }, { flag: "--share", slot: "share" }], slots: { secrets: { type: "flag" }, share: { type: "id", pattern: "guid", optional: true } }, output: { mode: "lines" } },
        },
      },
    },
  },
});

const parsedCli = () => readCredentialContribution(manifest()).cli;

function fake(routes) {
  const seen = [];
  const run = (launch) => {
    seen.push(launch);
    const line = launch.argv.join(" ");
    const route = routes.find(([prefix]) => line === prefix || line.startsWith(`${prefix} `));
    if (!route) return { status: 1, stderr: `no route: ${line}` };
    return typeof route[1] === "function" ? route[1](launch) : route[1];
  };
  run.seen = seen;
  return run;
}

const base = { state: () => ({ state: "locked" }), signOut: () => undefined, list: () => [], reveal: () => ({}) };

const passwordSignIn = {
  ...base,
  unlock: () => SignIn.done(),
  async signIn(request, ctx) {
    const run = await ctx.cli.verb("login", { email: request.fields.email, password: request.fields.masterPassword, ...(request.code ? { code: request.code, method: "0" } : {}) });
    if (run.hints.includes("wrongCode")) return SignIn.needs({ kind: "code" }, { problem: "wrongCode" });
    if (!run.succeeded) return SignIn.failed("wrongPassword", { detail: run.stderr });
    return SignIn.done();
  },
};

test("buildVerbLaunch renders slots, --flag=value forms, env and test folders as native does", () => {
  const launch = buildVerbLaunch(manifest(), "login", { email: "me@example.com", password: { $secret: "h1" }, method: "0", code: "123456" }, () => PASSWORD, "/scratch/fv");
  assert.deepEqual(launch, {
    verb: "login",
    argv: ["login", "me@example.com", "--raw", "--method=0", "--code=123456"],
    env: { FAKE_NOINTERACTION: "true", FAKE_DATA: "/scratch/fv/data", FAKE_KEYS: "fs", FAKE_PASSWORD: PASSWORD },
    stdin: "",
    timeoutMs: 30000,
    signIn: true,
  });
  const outside = buildVerbLaunch(manifest(), "login", { email: "me@example.com", password: { $secret: "h1" } }, () => PASSWORD, null);
  assert.deepEqual(outside.env, { FAKE_NOINTERACTION: "true", FAKE_PASSWORD: PASSWORD });
});

test("buildVerb refuses what native refuses, with its request code and message", () => {
  const c = parsedCli();
  const read = (verb, params, secret = () => PASSWORD) => {
    const built = buildVerb(c, verb, params, secret, null);
    return "launch" in built ? built.launch : built;
  };
  assert.deepEqual(read("list.all", {}), { code: "refused", message: "bw has no verb list.all." });
  assert.deepEqual(read("login", { email: "me@example.com", password: { $secret: "h1" }, code: "12 34" }), { code: "bad_request", message: "code for login must be 1 to 64 letters and digits." });
  assert.deepEqual(read("login", { password: { $secret: "h1" } }), { code: "bad_request", message: "email is required for login." });
  assert.deepEqual(read("login", { email: "me@example.com", password: { $secret: "h1" }, pin: "1" }), { code: "bad_request", message: "login has no slot named pin." });
  assert.deepEqual(read("login", { email: { $secret: "h2" }, password: { $secret: "h1" } }), { code: "bad_request", message: "a handle only goes in a secret slot." });
  assert.deepEqual(read("login", { email: "me@example.com", password: { $secret: "h4" } }, () => null), { code: "expired", message: "h4 was used or has ended." });
  assert.equal(read("login", { email: "-x@example.com", password: { $secret: "h1" } }).code, "bad_request");
  assert.equal(read("get", { session: { $secret: "h1" }, id: "--help" }).code, "bad_request");
  assert.equal(read("server", { url: "http://localhost:8080" }).argv.at(-1), "http://localhost:8080");
  assert.equal(read("server", { url: "http://vault.example.com" }).code, "bad_request");
  assert.equal(read("server", { url: "https://user:pw@vault.example.com" }).code, "bad_request");
  assert.deepEqual(read("show", { share: "-1111111-2222-3333-4444-555555555555" }).argv, ["show", "--share=-1111111-2222-3333-4444-555555555555"]);
  const stdin = read("create", { session: { $secret: "h1" }, item: { name: "é", a: 1 } }).stdin;
  assert.equal(Buffer.from(stdin, "base64").toString("utf8"), '{"a":1,"name":"é"}');
});

test("denied commands are refused after the CLI's global flags, whatever the catalog says", () => {
  const c = { ...parsedCli(), name: "op", verbs: { read: { argv: ["--account", "work", "read", "--out-file", "x"], slots: {}, env: [], stdin: null, timeoutMs: 30000, outputLimitBytes: 1024, output: { mode: "lines" }, signIn: false, unlocks: false, outlivesCall: false, hints: {} } } };
  assert.deepEqual(buildVerb(c, "read", {}, () => null, null), { code: "denied", message: "op read --out-file is never allowed." });
  const run = (name, argv) => buildVerb({ ...c, name, verbs: { v: { ...c.verbs.read, argv } } }, "v", {}, () => null, null);
  assert.deepEqual(run("op", ["read", "op://v/i/f", "-o", "x"]), { code: "denied", message: "op read -o is never allowed." });
  assert.deepEqual(run("op", ["document", "get", "d", "-ox"]), { code: "denied", message: "op document get -o is never allowed." });
  assert.deepEqual(run("op", ["connect", "token"]), { code: "denied", message: "op connect is never allowed." });
  assert.deepEqual(run("op", ["item", "share", "i"]), { code: "denied", message: "op item share is never allowed." });
  assert.deepEqual(run("bw", ["create", "attachment", "--file=a"]), { code: "denied", message: "bw create attachment --file is never allowed." });
  assert.deepEqual(run("bw", ["get", "--raw", "attachment", "x"]), { code: "denied", message: "bw get attachment is never allowed." });
  assert.deepEqual(run("bw", ["--weird", "status"]), { code: "denied", message: "bw --weird is never allowed." });
  assert.equal(run("op", ["read", "op://v/i/f", "--no-newline"]).code, undefined);
});

test("a typed secret is single use once a verb that consumed it exits 0, and lasts three launches otherwise", async () => {
  const cliRun = fake([["login", { status: 1, stderr: "Invalid code" }]]);
  const provider = {
    ...passwordSignIn,
    async signIn(request, ctx) {
      const results = [];
      for (let i = 0; i < 4; i++) results.push((await ctx.cli.verb("login", { email: "me@example.com", password: request.fields.masterPassword })).succeeded);
      return SignIn.failed("wrongCode", { detail: String(results) });
    },
  };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: cliRun });
  const answer = await h.call("signIn", { method: "password", step: "start", fields: { email: "me@example.com", masterPassword: h.secret(PASSWORD) } });
  assert.equal(answer.ok, false);
  assert.equal(cliRun.seen.length, 3);
  assert.deepEqual(h.refused.map((r) => r.reason), ["h1 was used or has ended."]);
  const second = createCredentialHarness({ provider: passwordSignIn, manifest: manifest(), cli: fake([["login", { stdout: `${SESSION}\n` }]]), context: { touchID: true } });
  assert.deepEqual(await second.call("signIn", { method: "password", step: "start", fields: { email: "me@example.com", masterPassword: second.secret(PASSWORD) } }), { ok: true, result: { ok: true } });
  assert.deepEqual(second.session, { key: SESSION });
  assert.equal(second.storedSession, SESSION);
});

test("what a verb consumed is hidden in what comes back, and json stdin text is hidden from stderr", async () => {
  let seen;
  const provider = {
    ...passwordSignIn,
    async signIn(request, ctx) {
      seen = await ctx.cli.verb("login", { email: "me@example.com", password: request.fields.masterPassword });
      return SignIn.failed("failed");
    },
    async save(request, ctx) {
      const run = await ctx.cli.verb("create", { session: ctx.session.current.key, item: { password: request.login.password } });
      return { id: "x", title: run.stderr, username: JSON.stringify(run.json), urls: [] };
    },
  };
  const h = createCredentialHarness({
    provider,
    manifest: manifest(),
    cli: fake([
      ["login", { status: 1, stderr: `bad password ${PASSWORD}` }],
      ["create item", { status: 1, stdout: JSON.stringify({ echoed: SESSION }), stderr: "rejected new-password-123" }],
    ]),
    context: { session: { key: SESSION } },
  });
  await h.call("signIn", { method: "password", step: "start", fields: { email: "me@example.com", masterPassword: h.secret(PASSWORD) } });
  assert.equal(seen.stderr, "bad password [hidden]");
  const saved = await h.call("save", { login: { title: "t", username: "u", password: "new-password-123", url: "https://example.com" } });
  assert.deepEqual([saved.result.title, saved.result.username], ["rejected [hidden]", '{"echoed":"[hidden]"}']);
});

test("results may carry a handle only as a signIn or unlock session that came from takeStored", async () => {
  const provider = {
    ...passwordSignIn,
    async unlock(_request, ctx) {
      const stored = await ctx.session.takeStored("Unlock Fake Vault");
      return stored ? SignIn.done({ session: stored }) : SignIn.failed("stayedLocked");
    },
    reveal: (_request, ctx) => ({ password: ctx.session.current.key }),
  };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: fake([]), context: { touchID: true, storedSession: SESSION } });
  assert.deepEqual(await h.call("unlock", { password: null }), { ok: true, result: { ok: true } });
  assert.deepEqual(h.session, { key: SESSION });
  assert.deepEqual(h.confirmations, ["Unlock Fake Vault"]);
  assert.deepEqual(await h.call("reveal", { id: "x", fields: ["password"] }), { ok: false, error: { code: "invalid" } });
});

test("lock ends open calls as stale, runs onLock with the session, and restarts the run", async () => {
  let release;
  const cliRun = fake([["list items", () => new Promise((resolve) => (release = resolve))], ["lock", { stdout: "" }]]);
  const provider = { ...passwordSignIn, list: async (_request, ctx) => (await ctx.cli.verb("list", { session: ctx.session.current.key }), []) };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: cliRun, context: { session: { key: SESSION } } });
  const pending = h.call("list", { snapshot: null, cursor: null });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.lock();
  assert.deepEqual(await pending, { ok: false, error: { code: "stale" } });
  release({ stdout: "[]" });
  assert.deepEqual(cliRun.seen.at(-1).env.FAKE_SESSION, SESSION);
  assert.equal(h.session, null);
  assert.equal(h.runs, 2);
  const touch = createCredentialHarness({ provider, manifest: manifest(), cli: fake([]), context: { session: { key: SESSION }, touchID: true } });
  await touch.lock();
  assert.equal(touch.launches.length, 0);
});

test("json items arrive one by one and a big json answer arrives in parts", async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  const big = { blob: "x".repeat(600_000) };
  const provider = {
    ...passwordSignIn,
    async list(_request, ctx) {
      const got = [];
      const run = await ctx.cli.verb("list", { session: ctx.session.current.key }, { onItem: (item, index) => got.push([item.id, index]) });
      const one = await ctx.cli.verb("get", { session: ctx.session.current.key, id: "11111111-2222-3333-4444-555555555555" });
      return [{ id: "r", title: JSON.stringify({ got, items: run.items, json: run.json, blob: one.json.blob.length }), username: "", urls: [] }];
    },
  };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: fake([["list items", { stdout: `[INFO] update available\n${JSON.stringify(items)}` }], ["get item", { stdout: JSON.stringify(big) }]]), context: { session: { key: SESSION } } });
  const answer = await h.call("list", { snapshot: null, cursor: null });
  assert.deepEqual(JSON.parse(answer.result.items[0].title), { got: items.map((item, i) => [item.id, i]), items: 5, json: [], blob: 600_000 });
});

test("an outlivesCall sign-in keeps running after its call, then unlocks and records its hints", async () => {
  const provider = {
    ...passwordSignIn,
    async signIn(_request, ctx) {
      const url = await new Promise((resolve) => {
        void ctx.cli.verb("browser", {}, { onLine: (line) => resolve(line.text) });
      });
      return SignIn.needs({ kind: "approval", url });
    },
    state: (_request, ctx) => ({ state: ctx.cli.signInRun.state === "succeeded" ? "unlocked" : "locked", detail: ctx.cli.signInRun.hints.join(",") }),
  };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: fake([["login --browser", { lines: [{ stream: "stdout", text: "https://example.com/approve" }], stderr: "needs extra password", finishAfterMs: 5000 }]]) });
  const answer = await h.call("signIn", { method: "browser", step: "start", fields: {} });
  assert.deepEqual(answer.result, { ok: false, need: { kind: "approval", url: "https://example.com/approve" } });
  assert.equal(h.signInRun.state, "running");
  await h.advance(5000);
  assert.equal(h.signInRun.state, "succeeded");
  assert.deepEqual(h.session, { key: null });
  assert.deepEqual((await h.call("state", { explicit: false })).result, { state: "unlocked", detail: "extraPassword" });
});

test("signOut forgets the session, scratch and preferences; values.set holds its limits", async () => {
  const provider = {
    ...passwordSignIn,
    async state(_request, ctx) {
      await ctx.scratch.set("syncedAt", "1");
      await ctx.preferences.set("account", "me");
      await ctx.preferences.set("bad key!", "x").catch((error) => ctx.scratch.set("refused", error.code));
      return { state: "unlocked" };
    },
  };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: fake([]), context: { session: { key: SESSION } } });
  await h.call("state", { explicit: false });
  assert.deepEqual([h.scratch, h.preferences], [{ syncedAt: "1", refused: "bad_request" }, { account: "me" }]);
  await h.call("signOut", {});
  assert.deepEqual([h.session, h.scratch, h.preferences, h.epoch], [null, {}, {}, 2]);
});

test("a call past its deadline is cancelled and answered timedOut", async () => {
  const provider = { ...passwordSignIn, reveal: (_request, ctx) => new Promise((resolve) => ctx.signal.onCancel(() => resolve({}))) };
  const h = createCredentialHarness({ provider, manifest: manifest(), cli: fake([]) });
  const pending = h.call("reveal", { id: "x", fields: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.advance(90_000);
  assert.deepEqual(await pending, { ok: false, error: { code: "timedOut" } });
});

test("a harness whose host speaks another credentials protocol stops before any call", async () => {
  const h = createCredentialHarness({ provider: passwordSignIn, manifest: manifest(), cli: fake([]), helloCredentials: [7] });
  assert.deepEqual(await h.call("state", { explicit: false }), { ok: false, error: { code: "stopped" } });
  assert.deepEqual(h.handlers, []);
  const ok = createCredentialHarness({ provider: passwordSignIn, manifest: manifest(), cli: fake([]) });
  await ok.call("state", { explicit: false });
  assert.deepEqual(ok.handlers, ["state", "signIn", "unlock", "signOut", "list", "reveal"]);
});

test("checkCredentialManifest accepts the harness manifest", () => {
  assert.deepEqual(checkCredentialManifest(manifest()), []);
});

test("buildVerb agrees with the native argv builder on the shared fixture", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("packages/ardiacore/tests/fixtures/credential-verbs.json isn't there yet (the native side writes it)");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length > 0, "the fixture has cases");
  const clis = Object.fromEntries(Object.entries(fixture.manifests).map(([id, m]) => [id, readCredentialContribution(m).cli]));
  const lookup = (handle) => (Object.hasOwn(fixture.secrets, handle.$secret) ? fixture.secrets[handle.$secret] : null);
  for (const item of fixture.cases) {
    const built = buildVerb(clis[item.manifest], item.verb, item.params ?? {}, lookup, item.testInstance ? fixture.testFolder : null);
    if (item.refused) {
      assert.deepEqual("code" in built ? { code: built.code, message: built.message } : null, item.refused, item.name);
      continue;
    }
    assert.ok("launch" in built, `${item.name}: ${built.message}`);
    const { verb: _verb, ...launch } = built.launch;
    assert.deepEqual({ ...launch, timeoutMs: effectiveTimeout(item.timeoutMs, launch.timeoutMs) }, item.launch, item.name);
  }
});
