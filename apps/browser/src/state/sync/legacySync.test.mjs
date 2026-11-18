import assert from "node:assert/strict";
import { test } from "node:test";

const files = new Map();
const downloading = new Set();
let nextFile = 0;
const read = (scope, known) => {
  const found = [...files].filter(([, file]) => file.scope === scope);
  return {
    files: found.filter(([id]) => !known.includes(id) && !downloading.has(id)).map(([id, file]) => ({ id, payload: file.payload })),
    present: found.map(([id]) => id),
    pending: found.filter(([id]) => downloading.has(id)).map(([id]) => id),
    damaged: [],
  };
};
const write = (scope, payload) => {
  const id = `file-${++nextFile}`;
  files.set(id, { scope, payload });
  return id;
};
const remove = (scope, ids) => { for (const id of ids) if (files.get(id)?.scope === scope) files.delete(id); };
const transport = { read: async (...args) => read(...args), write: async (...args) => write(...args), remove: async (...args) => remove(...args) };
let nextDevice = 0;
globalThis.__DEV__ = false;
globalThis.acTestNativeModules = { ArdiaSync: {
  newDeviceId: () => `new-${++nextDevice}`,
  deviceName: () => "New desktop",
  chainStatus: async () => "ok",
  unlock: async () => true,
  forget: async () => {},
  enterPhrase: async () => ({ ok: true }),
  createPhrase: async () => true,
  createChain: async () => {},
  sealLocal: async (text) => `sealed:${text}`,
  openLocal: async (sealed) => sealed.startsWith("sealed:") ? sealed.slice(7) : null,
  read: async (_folder, ...args) => read(...args),
  write: async (_folder, ...args) => write(...args),
  remove: async (_folder, ...args) => remove(...args),
  readPasswords: async () => null,
} };
globalThis.__host = {
  chainStatus: () => "ok",
  read: (scope, known) => JSON.stringify(read(scope, JSON.parse(known))),
  write,
  remove: (scope, ids) => { remove(scope, JSON.parse(ids)); return "ok"; },
  saveState: () => "ok",
  persistJournal: () => "ok",
};

const { Clock, emptyScope, pull } = await import("@ardia/sync");
const { compact: oldCompact, emptyScope: oldScope, pull: oldPull } = await import("../../../../../packages/sync/src/fixtures/scope-v0.2.38.ts");
const { companionLoad } = await import("../../../../../packages/sync/src/companion/state.ts");
const { companionAcknowledge, companionSend, runCompanionCycle } = await import("../../../../../packages/sync/src/companion/cycle.ts");
const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();
const clock = new Clock("legacy-mac");
const stamp = () => clock.tick();
let seqs = {};
function log(scope, records) {
  const seq = (seqs[scope] ?? 0) + 1;
  seqs[scope] = seq;
  const payload = { v: 1, kind: "log", device: "legacy-mac", seq, at: Date.now(), ops: Object.entries(records).map(([k,v]) => ({ k, v, h: stamp() })) };
  write(scope, JSON.stringify(payload));
  return payload;
}

async function run(engine, rounds = 3) {
  for (let i = 0; i < rounds; i++) await engine.syncNow();
}

async function waitReady(engine) {
  for (let i = 0; i < 80 && engine.useSync.getState().status === "starting"; i++) {
    await engine.syncNow();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(engine.useSync.getState().status, "updated");
}

const link = (syncId) => ({ syncId, enabled: true });
const tile = { g: null, u: "https://tile.test/", t: null, i: null, ti: "Tile", pos: "V" };
const bookmark = (t, u) => ({ k: "u", p: "other", a: 1, t, u, pos: "V" });

test("a migrated desktop and the shipping iPhone exchange edits with an older desktop in the original scopes", async () => {
  files.clear();
  shell.docs.clear();
  seqs = {};
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  const work = S().createSpace({ name: "Work", profileId: "default" });
  S().createWindow({ spaceId: work, url: "https://work.example/" });
  log("app", {
    "prof:A": { n: "Home", c: "plum", i: null, d: true },
    "prof:B": { n: "Work from the old Mac", c: "blue", i: null },
    "share:B": { o: "A" },
    "pta:B": { on: true },
    "dev:legacy-mac": { n: "Old desktop", k: "mac", f: ["send"] },
  });
  log("p:A", { "bm:old-bookmark": bookmark("Old bookmark", "https://old.test/") });
  log("p:B", { "pin:t:legacy-key": tile });

  const pending = { v: 1, kind: "log", device: "existing-device", at: Date.now(), seq: 7, ops: [{ k: "set:restoreSession", v: { v: true }, h: stamp() }] };
  shell.docs.set("sync.json", JSON.stringify({ v: 1, enabled: true, folder: "/sync", deviceId: "existing-device", clock: clock.last, profiles: { default: link("A"), [work]: link("B") }, seqs: { app: 6 } }));
  shell.docs.set("sync-journal-1.nns", `sealed:${JSON.stringify({ id: 1, version: 1, journal: { app: [pending] } })}`);
  const engine = await import("./engine.ts?compat");
  engine.startSync();
  try {
    await waitReady(engine);
    await run(engine);
    assert.equal(S().spaces[work].name, "Work from the old Mac");
    assert.equal(S().spaces[work].profileId, "default");
    assert.equal(S().spaces[work].syncProfileLocked, true);
    assert.equal(S().spaces[work].shareTopApps, true);
    const isolated = S().createProfile({ name: "Isolated" });
    S().assignSpaceProfile(work, isolated);
    assert.equal(S().spaces[work].profileId, "default");
    assert.ok(Object.values(S().bookmarks.nodes).some((node) => node.title === "Old bookmark"));
    assert.ok(Object.values(S().tabs).some((tab) => (tab.pinKey ?? tab.id) === "legacy-key" && tab.pin?.as === "tile") ||
      S().parkedPins[work]?.tabs.some((tab) => tab.id === "legacy-key" && tab.pin?.as === "tile"), "the legacy pin key is preserved");
    assert.ok([...files.values()].some(({ scope, payload }) => scope === "app" && payload === JSON.stringify(pending)));

    S().addBookmark({ spaceId: work, title: "New bookmark", url: "https://new.test/" });
    S().updateProfile("default", { name: "Personal identity" });
    log("app", { "prof:B": { n: "Work renamed offline", c: "blue", i: null } });
    await run(engine);
    assert.equal(S().spaces[work].name, "Work renamed offline");

    companionLoad({ device: "iphone", fresh: true });
    const phone = await runCompanionCycle({ name: "iPhone", tabs: [{ u: "https://phone.test/", t: "Phone", p: "B", a: Date.now() }] });
    const phoneWork = phone.view.profiles.find((profile) => profile.syncId === "B");
    assert.equal(phoneWork.name, "Work renamed offline");
    assert.match(JSON.stringify(phoneWork.bookmarks), /New bookmark/);
    assert.match(JSON.stringify(phoneWork.pinned), /tile.test/);
    assert.ok(companionSend({ profile: "B", key: "from-phone", u: "https://received.test/", t: "Sent by phone", to: "existing-device", at: Date.now() }));
    await runCompanionCycle({ name: "iPhone" });
    await run(engine);
    assert.equal(Object.values(S().tabs).filter((tab) => tab.spaceId === work && tab.url === "https://received.test/").length, 1);

    const tab = Object.values(S().tabs).find((item) => item.spaceId === work && item.url === "https://work.example/");
    assert.ok(engine.sendTab(tab.id, "iphone"));
    await run(engine);
    const incoming = await runCompanionCycle({ name: "iPhone" });
    assert.deepEqual(incoming.received.map(({ profile, u }) => [profile, u]), [["B", "https://work.example/"]]);
    companionAcknowledge({ items: incoming.received.map(({ profile, key }) => ({ profile, key })) });
    await runCompanionCycle({ name: "iPhone" });

    log("p:B", { "pin:t:legacy-key": null });
    await run(engine);
    const stillPinned = Object.values(S().tabs).some((tab) => (tab.pinKey ?? tab.id) === "legacy-key" && tab.pin?.as === "tile") ||
      S().parkedPins[work]?.tabs.some((tab) => tab.id === "legacy-key" && tab.pin?.as === "tile");
    assert.ok(!stillPinned);
    const updatedPhone = await runCompanionCycle({ name: "iPhone" });
    assert.doesNotMatch(JSON.stringify(updatedPhone.view.profiles.find((profile) => profile.syncId === "B").pinned), /tile.test/);

    const state = oldScope();
    const old = new Clock("legacy-mac");
    await oldPull(state, transport, "app", old, Date.now());
    assert.equal(state.records["identity:A"].v.n, "Personal identity");
    await oldCompact(state, transport, "app", "legacy-mac", Date.now(), {}, true);
    const after = emptyScope();
    await pull(after, transport, "app", new Clock("new-peer"), Date.now());
    assert.equal(after.records["identity:A"].v.n, "Personal identity");
    assert.deepEqual(after.records["share:B"].v, { o: "A" });
    assert.ok([...files.values()].every(({ scope }) => ["app", "p:A", "p:B"].includes(scope)));
  } finally {
    await engine.stopSync();
  }
});

test("the preview stays paused and keeps both sets of saved files", async () => {
  S().hydrate({});
  shell.docs.clear();
  files.clear();
  const original = {
    "sync.json": JSON.stringify({ v: 2, enabled: true, deviceId: "preview", protocolReady: true, folder: "/sync" }),
    "sync-spaces-state.nns": "preview ciphertext",
    "sync-state.nns": "legacy ciphertext",
  };
  for (const [name, contents] of Object.entries(original)) shell.docs.set(name, contents);
  const engine = await import("./engine.ts?preview");
  engine.startSync();
  assert.equal(engine.useSync.getState().status, "preview");
  await engine.syncNow();
  await engine.stopSync({ deleteData: true });
  assert.deepEqual(Object.fromEntries(shell.docs), original);
  assert.equal(files.size, 0);
});

test("joining a folder with a downloading preview file pauses before publishing or deleting anything", async () => {
  S().hydrate({});
  shell.docs.clear();
  files.clear();
  const id = write("workspace-v2", "preview data");
  downloading.add(id);
  log("app", { "prof:A": { n: "Home", c: "plum", i: null, d: true } });
  const before = new Map(files);
  const engine = await import("./engine.ts?preview-in-folder");
  try {
    engine.startSync();
    assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "test phrase")));
    await run(engine);
    assert.equal(engine.useSync.getState().status, "preview");
    await engine.stopSync({ deleteData: true });
    assert.deepEqual(files, before);
  } finally {
    downloading.clear();
  }
});
