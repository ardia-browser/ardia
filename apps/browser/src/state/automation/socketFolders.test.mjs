import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { cacheKey } = await import("../favicons/favicons.ts");
const { encodeSetupCode } = await import("../presets/setupCode.ts");
const { keepGroupsOpen } = await import("../groups/closeGuard.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 17, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 17); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 17);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  const first = S().windows[windowId].tabIds[0];
  const tabs = [first, ...["b", "c", "d"].map((h) => S().newTab(windowId, { url: `https://${h}.example/`, background: true }))];
  return { windowId, tabs };
}

const folderOf = (tab) => S().tabs[tab].pin?.folder?.id;

test("tile folders: make one of tabs, which become tiles; rename, add, take out, remove", async () => {
  const { windowId, tabs: [a, b, c, d] } = await setup();
  assert.deepEqual(await ok("pins.folders"), []);
  const made = await ok("pins.createFolder", { tabs: [a, b], name: " Work " });
  assert.equal(made.name, "Work");
  assert.deepEqual(new Set(made.tabs), new Set([a, b]));
  assert.ok([a, b].every((t) => S().tabs[t].pin?.as === "tile" && folderOf(t) === made.id), "both are tiles in the folder");
  assert.deepEqual((await ok("pins.folders", { window: windowId })).map((f) => f.id), [made.id]);
  assert.equal((await ok("pins.renameFolder", { folder: made.id, name: "Play" })).name, "Play");
  const grown = await ok("pins.addToFolder", { folder: made.id, tabs: [c] });
  assert.equal(grown.tabs.length, 3);
  assert.equal(S().tabs[c].pin?.as, "tile");
  await ok("pins.removeFromFolder", { tabs: [c] });
  assert.equal(folderOf(c), undefined);
  assert.equal(S().tabs[c].pin?.as, "tile", "it stays a tile");
  assert.equal(await code("pins.removeFromFolder", { tabs: [d] }), "bad_request");
  assert.equal(await code("pins.renameFolder", { folder: "tf-nope", name: "x" }), "no_window");
  assert.equal(await code("pins.createFolder", { tabs: [] }), "bad_request");
  assert.equal(await code("pins.createFolder", { tabs: ["nope"] }), "no_window");
  const removed = await ok("pins.removeFolder", { folder: made.id });
  assert.deepEqual(new Set(removed.tabs), new Set([a, b]));
  assert.ok([a, b].every((t) => S().tabs[t].pin?.as === "tile" && !folderOf(t)), "the tabs stay tiles");
  assert.deepEqual(await ok("pins.folders"), []);
});

test("tile folders refuse tabs from two windows and Little Ardia", async () => {
  const { tabs: [a] } = await setup();
  const other = S().createWindow({ url: "https://z.example/" });
  assert.equal(await code("pins.createFolder", { tabs: [a, S().windows[other].tabIds[0]] }), "bad_request");
  const little = S().createWindow({ url: "https://l.example/", kind: "small" });
  if (S().windows[little]?.kind === "small") assert.equal(await code("pins.createFolder", { tabs: [S().windows[little].tabIds[0]] }), "bad_request");
});

test("a folder mirrored into another window is found in the window of the tabs being added", async () => {
  const { tabs: [, , , d] } = await setup();
  const other = S().createWindow({ url: "https://o.example/" });
  const own = S().windows[other].tabIds[0];
  const extra = S().newTab(other, { url: "https://p.example/", background: true });
  const made = await ok("pins.createFolder", { tabs: [own] });
  assert.ok(Object.values(S().tabs).some((t) => t.windowId !== other && t.pin?.folder?.id === made.id), "the folder is mirrored into the first window");
  const grown = await ok("pins.addToFolder", { folder: made.id, tabs: [extra] });
  assert.equal(grown.window, other);
  assert.ok(grown.tabs.includes(extra));
  assert.equal(await code("pins.addToFolder", { folder: made.id, tabs: [d], window: other }), "bad_request");
});

test("tile folders refuse to empty a shared sidebar folder, as apply does", async () => {
  const { tabs: [a, b, c] } = await setup();
  const shared = S().groupTabs([b], { pinned: true, name: "Shared" });
  keepGroupsOpen((id) => id === shared);
  try {
    assert.equal(await code("pins.createFolder", { tabs: [b] }), "refused");
    assert.deepEqual(S().groups[shared]?.tabIds, [b], "the shared folder keeps its tab");
    const made = await ok("pins.createFolder", { tabs: [a] });
    assert.equal(await code("pins.addToFolder", { folder: made.id, tabs: [b] }), "refused");
    assert.deepEqual(S().groups[shared]?.tabIds, [b]);
    assert.equal(S().tabs[b].pin?.as === "tile", false);
    assert.ok((await ok("pins.addToFolder", { folder: made.id, tabs: [c] })).tabs.includes(c));
  } finally {
    keepGroupsOpen(() => false);
  }
});

test("tile folders refuse a split's pane before changing anything, as the sidebar's folder drop does", async () => {
  const { tabs: [a, b, c, d] } = await setup();
  S().createSplit([b, c]);
  const split = JSON.stringify(S().splits);
  assert.equal(await code("pins.createFolder", { tabs: [a, b] }), "bad_request");
  assert.deepEqual([S().tabs[a].pin, S().tabs[b].pin, S().tabs[c].pin], [null, null, null], "nothing was pinned");
  assert.equal(JSON.stringify(S().splits), split, "the split is untouched");
  const made = await ok("pins.createFolder", { tabs: [d] });
  assert.equal(await code("pins.addToFolder", { folder: made.id, tabs: [c] }), "bad_request");
  assert.deepEqual([S().tabs[b].pin, S().tabs[c].pin], [null, null]);
  assert.equal(JSON.stringify(S().splits), split);
});

test("favicons: from the app's cache or the profile's icon database, as base64", async () => {
  await setup();
  const profile = S().settings.defaultProfileId;
  stub.chromeFavicons.set(`${cacheKey(profile)}|https://icons.example/page`, "data:image/png;base64,iVBORw0K");
  assert.deepEqual(await ok("favicons.get", { url: "https://icons.example/page#top" }), { url: "https://icons.example/page", profile, found: true, mime: "image/png", data: "iVBORw0K" });
  assert.equal((await ok("favicons.get", { url: "https://none.example/" })).found, false);
  assert.equal(await code("favicons.get", { url: "file:///etc/passwd" }), "bad_request");
  assert.equal(await code("favicons.get", { url: "https://x.example/", profile: "nope" }), "no_window");
});

test("presets: describe a setup code without changing anything, then apply it", async () => {
  const { windowId } = await setup();
  const setup1 = encodeSetupCode({ settings: { sidebarSide: "right", appearance: "dark" }, color: "green" });
  const before = S().settings.sidebarSide;
  const described = await ok("presets.describe", { code: setup1 });
  assert.deepEqual(described.settings, { sidebarSide: "right", appearance: "dark" });
  assert.equal(described.color, "green");
  assert.equal(S().settings.sidebarSide, before, "describing changes nothing");
  const applied = await ok("presets.apply", { code: setup1 });
  assert.equal(applied.window, windowId);
  assert.ok(applied.lines.length > 0);
  assert.equal(S().settings.sidebarSide, "right");
  assert.equal(S().settings.appearance, "dark");
  assert.equal(await code("presets.apply", { code: "ardia1-garbage-zz" }), "bad_request");
  assert.equal(await code("presets.apply", { code: setup1, window: "nope" }), "no_window");
});

test("the new areas describe themselves, take only what they list, and count in their own families", async () => {
  await setup();
  const names = (await ok("methods")).map((m) => m.name);
  for (const name of ["pins.folders", "pins.createFolder", "favicons.get", "sharedFolders.list", "live.list", "live.refresh", "live.hide", "presets.apply", "airTraffic.rules", "airTraffic.addRule"]) assert.ok(names.includes(name), name);
  for (const name of ["sharedFolders.share", "sharedFolders.add", "sharedFolders.sync", "sharedFolders.stop"]) assert.ok(!names.includes(name), `${name} waits for the shared-folder follow-up`);
  assert.equal(await code("pins.folders", { window: 3 }), "bad_request");
  assert.equal(await code("favicons.get", { url: "https://a.example/", size: 64 }), "bad_request");
  setConsentPeriod(true, "socket-folders-test");
  takeCliCounts();
  await ok("pins.folders");
  await call("favicons.get", { url: "nope" });
  await ok("airTraffic.rules");
  await ok("live.list");
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_calls_pins, 1);
  assert.equal(counts.cli_socket_calls_favicons, 1);
  assert.equal(counts.cli_socket_calls_air_traffic, 1);
  assert.equal(counts.cli_socket_calls_live, 1);
  assert.equal(counts.cli_socket_call_failures, 1);
});
