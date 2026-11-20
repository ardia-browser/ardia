import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, controlOn, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { schemaProblem, obj } = await import("./socketSchema.ts");
const { familyOf, methodSpec, accessProblem, PLUGIN_SESSION_METHODS } = await import("./socketCatalog.ts");
const stub = await import("../../test-native/index.ts");

const { fire, call, ok } = socketClient(21);

test("turning control off while a call waits on a read stops the write that would follow it", async () => {
  await freshWindow();
  stub.passwordStores.set(null, new Map([["https://site.example\nme", { origin: "https://site.example", url: "https://site.example", username: "me", password: "pw", created: 1 }]]));
  const removing = fire("passwords.remove", { origin: "https://site.example", username: "me" });
  S().updateSettings({ cliControl: false });
  const reply = await removing;
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /turned off/);
  assert.equal(stub.passwordStores.get(null).size, 1, "the login is still saved");

  await controlOn();
  stub.downloadSettingsWrites.length = 0;
  const setting = fire("downloads.setSettings", { askWhereToSave: true });
  S().updateSettings({ cliControl: false });
  assert.equal((await setting).error?.code, "failed");
  assert.equal(stub.downloadSettingsWrites.length, 0, "the download settings weren't written");

  await controlOn();
  const other = S().createWindow({ url: "https://b.example/" });
  S().updateSettings({ warnBeforeClosingWindow: false });
  const closing = fire("windows.close", { window: other });
  S().updateSettings({ cliControl: false });
  assert.equal((await closing).error?.code, "failed");
  assert.ok(S().windows[other], "the window stayed open");
  await controlOn();
});

test("numbers must be finite: the schema, split weights and media seeking", async () => {
  const { windowId, tab } = await freshWindow();
  assert.equal(schemaProblem({ type: "number" }, Infinity, "n"), "n must be a finite number.");
  assert.equal(schemaProblem({ type: "number" }, NaN, "n"), "n must be a finite number.");
  const b = S().newTab(windowId, { url: "https://b.example/", background: true });
  const split = await ok("splits.create", { tabs: [tab, b] });
  const huge = await fire("splits.resize", null, JSON.stringify({ id: 900, method: "splits.resize", params: { split: split.id, sizes: [1e308, 1e308] } }));
  assert.equal(huge.error?.code, "bad_request");
  const infinite = await fire("splits.resize", null, JSON.stringify({ id: 901, method: "splits.resize", params: { split: split.id, sizes: [1e999, 1] } }));
  assert.equal(infinite.error?.code, "bad_request");
  assert.ok(S().splits[split.id].slots.every((slot) => Number.isFinite(slot.size) && slot.size > 0));
  const seek = await fire("media.control", null, JSON.stringify({ id: 902, method: "media.control", params: { tab, action: "seekTo", seconds: 1e999 } }));
  assert.equal(seek.error?.code, "bad_request");
  assert.equal((await call("media.control", { tab, action: "seekTo", seconds: -5 })).error?.code, "bad_request");
});

test("closed schemas, required fields and method families only count own properties", async () => {
  const schema = obj({ a: { type: "string" } }, ["a"]);
  assert.match(schemaProblem(schema, JSON.parse('{"a":"x","constructor":1}'), "params"), /takes no constructor/);
  assert.match(schemaProblem(obj({}, ["toString"]), {}, "params"), /toString is required/i);
  assert.equal(familyOf("constructor.list"), "core");
  assert.equal(familyOf("__proto__.list"), "core");
  await freshWindow();
  assert.equal((await call("tabs.list", { constructor: 1 })).error?.code, "bad_request");
  assert.equal((await call("toString")).error?.code, "unknown_method");
});

test("every method, the core and plugin ones included, is checked against its schema before it runs", async () => {
  await freshWindow();
  assert.equal((await call("subscribe", { events: [], bogus: 1 })).error?.code, "bad_request");
  assert.equal((await call("answer", {})).error?.code, "bad_request");
  assert.match((await call("answer", {})).error.message, /decide is required/i);
  assert.equal((await call("run", { command: 3 })).error?.code, "bad_request");
  assert.equal((await call("windows", { all: true })).error?.code, "bad_request");
  assert.match((await call("plugins.enable", {})).error.message, /name is required/i);
  assert.equal((await call("hello", { protocol: "four" })).error?.code, "bad_request");
});

test("subscribe and answer list the params they read and say they change state", async () => {
  await freshWindow();
  const list = await ok("methods");
  const subscribe = list.find((m) => m.name === "subscribe");
  assert.deepEqual(Object.keys(subscribe.params.properties).sort(), ["events", "fullUrls", "hooks", "idle"]);
  assert.equal(subscribe.mutates, true);
  const answer = list.find((m) => m.name === "answer");
  assert.deepEqual(answer.params.required, ["decide"]);
  assert.equal(answer.mutates, true);
  for (const m of list) assert.equal(m.params.additionalProperties === false || m.name === "hello", true, `${m.name} has a closed schema`);
});

function sample(schema) {
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "string") return schema.pattern ? "https://sample.example" : "sample";
  if (type === "integer") return schema.minimum ?? 1;
  if (type === "number") return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 1);
  if (type === "boolean") return true;
  if (type === "array") return schema.items && typeof schema.items === "object" ? Array.from({ length: schema.minItems ?? 1 }, () => sample(schema.items)) : [];
  if (type === "object") return schema.properties ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, sample(v)])) : {};
  return null;
}

test("every method reaches its real handler, and no handler reads a param its schema doesn't list", async () => {
  await freshWindow();
  const list = await ok("methods");
  const unlisted = [];
  const unhandled = [];
  for (const m of list) {
    for (const params of [{}, sample(m.params)]) {
      const reply = await call(m.name, params);
      if (/its params schema doesn't list/.test(reply.error?.message ?? "")) unlisted.push(reply.error.message);
      if (reply.error?.code === "unknown_method") unhandled.push(m.name);
    }
    await controlOn();
  }
  assert.deepEqual(unlisted, []);
  assert.deepEqual(unhandled, []);
});

test("plugins.call reads plugin, tool and input, the params the shipped command sends", async () => {
  await freshWindow();
  const reply = await call("plugins.call", { plugin: "nobody", tool: "hello", input: { who: "you" } });
  assert.ok(reply.error, "there's no plugin nobody");
  assert.doesNotMatch(reply.error.message, /schema doesn't list/);
  assert.notEqual(reply.error.code, "unknown_method");
});

test("a handler reading a param outside its schema fails loudly instead of reading it", async () => {
  const { listedParams } = await import("./socketCatalog.ts");
  const guarded = listedParams(methodSpec("tabs.get"), { tab: "t1" });
  assert.equal(guarded.tab, "t1");
  assert.throws(() => guarded.window, /tabs.get read window/);
  assert.throws(() => "window" in guarded, /tabs.get read window/);
  assert.throws(() => Object.hasOwn(guarded, "window"), /tabs.get read window/);
  assert.throws(() => Object.getOwnPropertyDescriptor(guarded, "window"), /tabs.get read window/);
  assert.equal("tab" in guarded, true);
  assert.deepEqual({ ...guarded }, { tab: "t1" });
  const nested = listedParams(methodSpec("subscribe"), { events: [], idle: { tab: [60] } });
  assert.deepEqual(nested.idle.tab, [60]);
  assert.throws(() => nested.idle.bogus, /subscribe read idle\.bogus/);
  assert.throws(() => "bogus" in nested.idle, /subscribe read idle\.bogus/);
});

test("a plugin's session reaches only the methods the dispatcher lets it", () => {
  assert.equal(accessProblem("owner", methodSpec("bookmarks.remove")), null);
  assert.equal(accessProblem("plugin", methodSpec("bookmarks.remove"))?.code, "refused");
  assert.equal(accessProblem("plugin", methodSpec("passwords.list"))?.code, "refused");
  for (const name of PLUGIN_SESSION_METHODS) assert.equal(accessProblem("plugin", methodSpec(name)), null);
});

test("sites.setZoom describes the profile it changed even when the default changes meanwhile", async () => {
  await freshWindow();
  stub.siteZoomDb.clear();
  const work = await ok("profiles.create", { name: "Work" });
  const zooming = fire("sites.setZoom", { host: "docs.example", zoom: 1.5 });
  S().setDefaultProfile(work.id);
  assert.deepEqual((await zooming).result, { "docs.example": 1.5 });
  await tick();
});
