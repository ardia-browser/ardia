import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { setNowPlaying } = await import("../media/media.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 13, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 13); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 13);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, tab: S().windows[windowId].activeTabIds[S().windows[windowId].profileId] };
}

test("sites: set a permission, read it back, list origins, reset; origins are checked", async () => {
  await setup();
  stub.siteSettingsDb.clear();
  const after = await ok("sites.set", { origin: "https://meet.example", type: "camera", value: "allow" });
  assert.deepEqual(after.camera, { value: "allow", isDefault: false });
  assert.deepEqual(await ok("sites.origins"), ["https://meet.example"]);
  assert.equal((await ok("sites.get", { origin: "https://meet.example" })).camera.value, "allow");
  assert.equal((await call("sites.set", { origin: "https://meet.example/path", type: "camera", value: "allow" })).error.code, "bad_request");
  assert.equal((await call("sites.set", { origin: "https://meet.example", type: "teleport", value: "allow" })).error.code, "bad_request");
  await ok("sites.reset", { origin: "https://meet.example" });
  assert.deepEqual(await ok("sites.origins"), []);
  assert.deepEqual(await ok("sites.setZoom", { host: "docs.example", zoom: 1.25 }), { "docs.example": 1.25 });
  assert.equal((await call("sites.setZoom", { host: "docs.example", zoom: 9 })).error.code, "bad_request");
});

test("media: list what plays, control it, seeking needs seconds", async () => {
  const { tab } = await setup();
  setNowPlaying(tab, { title: "Song", artist: "Band", album: "", artwork: null, playbackState: "playing", position: 3, duration: 200, playbackRate: 1, actions: [], loop: false, timestamp: Date.now() });
  const list = await ok("media.list");
  assert.equal(list.find((m) => m.tab === tab)?.title, "Song");
  assert.equal((await call("media.control", { tab, action: "seekTo" })).error.code, "bad_request");
  assert.equal((await call("media.control", { tab, action: "pause", seconds: 3 })).error.code, "bad_request");
  await ok("media.control", { tab, action: "pause" });
});

test("secrets: logins list without passwords and can be removed; cards without numbers", async () => {
  await setup();
  stub.passwordStores.set(null, new Map([["https://site.example\nme", { origin: "https://site.example", url: "https://site.example", username: "me", password: "hunter2", created: 1 }]]));
  const logins = await ok("passwords.list");
  assert.deepEqual(logins.map((l) => [l.origin, l.username]), [["https://site.example", "me"]]);
  assert.equal(JSON.stringify(logins).includes("hunter2"), false);
  await ok("passwords.remove", { origin: "https://site.example", username: "me" });
  assert.equal((await ok("passwords.list")).length, 0);
  assert.equal((await call("passwords.remove", { origin: "https://none.example", username: "x" })).error.code, "no_window");
  assert.deepEqual(await ok("autofill.list"), { addresses: [], cards: [] });
  assert.equal((await call("methods")).result.some((m) => /^(passwords|autofill)\.(reveal|cardNumber)/.test(m.name)), false);
});

test("sync status and extensions read without changing anything", async () => {
  await setup();
  const sync = await ok("sync.status");
  assert.equal(typeof sync.enabled, "boolean");
  assert.ok(Array.isArray(await ok("extensions.list")));
  assert.equal((await call("extensions.setEnabled", { id: "nope", enabled: false })).error.code, "no_window");
});
