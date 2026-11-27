import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const downloading = new Set();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `id${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    enterPhrase: async () => ({ ok: true }),
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const unknown = here.map(([id]) => id).filter((id) => !known.includes(id));
      const files = here.filter(([id]) => unknown.includes(id) && !downloading.has(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: unknown.filter((id) => downloading.has(id)), damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();

class Mac {
  constructor() {
    S().hydrate({});
    useBrowser.setState({ bookmarksReady: { "": true } });
    this.browser = S();
    this.docs = new Map();
  }
  async with(fn) {
    useBrowser.setState(this.browser, true);
    shell.docs.clear();
    for (const [k, v] of this.docs) shell.docs.set(k, v);
    try {
      return await fn();
    } finally {
      this.browser = S();
      this.docs = new Map(shell.docs);
    }
  }
}

const ops = () =>
  [...folder.values()]
    .map((f) => JSON.parse(f.payload))
    .flatMap((f) => f.ops ?? Object.entries(f.records ?? {}).map(([k, r]) => ({ k, v: r.v })));
const published = (prefix) => ops().filter((op) => op.k.startsWith(prefix));
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const named = (name) => S().profileOrder.find((id) => S().profiles[id].name === name);
const syncIdOf = (engine, name) => engine.useSync.getState().profiles[named(name)]?.syncId;
const syncDoc = () => JSON.parse(shell.docs.get("sync.json"));

async function turnOn(mac, engine) {
  await mac.with(async () => {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync("/sync")));
    await engine.syncNow();
    await engine.syncNow();
  });
}

async function join(mac, engine) {
  await mac.with(async () => {
    engine.startSync();
    assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", asSecret("syncPhrase", "words"))));
    await engine.syncNow();
    await engine.syncNow();
  });
}

async function relaunch(mac, tag, browser = mac.browser) {
  mac.browser = browser;
  const engine = await import(`./engine.ts?${tag}`);
  await mac.with(async () => {
    engine.startSync();
    await settle();
    await engine.syncNow();
  });
  return engine;
}

function pin(urls) {
  const w = Object.keys(S().windows)[0] ?? S().createWindow({});
  const tabs = urls.map((url) => S().newTab(w, { url, background: true }));
  S().pinTabs(tabs, true);
  return tabs;
}

const pinnedUrls = (profileId = "default") =>
  Object.values(S().tabs)
    .filter((t) => t.profileId === profileId && t.pin)
    .map((t) => t.url)
    .sort();

test("#1945: a Mac that joins while the file with a profile is still downloading pairs it by name instead of publishing a duplicate, and takes its colour", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?pairA");
  const engineB = await import("./engine.ts?pairB");
  await turnOn(a, engineA);
  await a.with(async () => {
    const work = S().createProfile({ name: "Work", color: "green" });
    S().setProfileLook(work, { color: "green" });
    await engineA.syncNow();
    await engineA.syncNow();
  });
  const workFile = [...folder].find(([, f]) => f.scope === "app" && f.payload.includes('"n":"Work"'))?.[0];
  assert.ok(workFile, "Work's profile record is in a later file than Personal's");
  downloading.add(workFile);
  try {
    await b.with(() => S().createProfile({ name: "Work", color: "red" }));
    await join(b, engineB);
    await b.with(() => {
      const ui = engineB.useSync.getState();
      assert.equal(ui.joining, true, "B waits for the file still downloading before it pairs");
      assert.equal(ui.firstSync, true, "and Settings › Sync says the first sync is still running");
      assert.deepEqual(ui.profiles, {});
    });
  } finally {
    downloading.delete(workFile);
  }
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
  });
  const workOnA = await a.with(() => syncIdOf(engineA, "Work"));
  await b.with(() => {
    assert.equal(syncIdOf(engineB, "Work"), workOnA, "B's Work pairs with A's Work");
    assert.equal(S().profiles[named("Work")].color, "green", "and takes its colour");
    assert.equal(engineB.useSync.getState().firstSync, false);
  });
  const workRecords = new Set(published("prof:").filter((op) => op.v?.n === "Work").map((op) => op.k));
  assert.equal(workRecords.size, 1, "no second Work record reaches the folder");
  await a.with(async () => {
    await engineA.syncNow();
    assert.deepEqual(engineA.useSync.getState().remoteProfiles, [], "A isn't offered a duplicate Work");
    assert.equal(S().profiles[named("Work")].color, "green", "and A's colour doesn't drift to B's");
  });
});

test("#1945: a Mac that joins while a later file is still downloading doesn't pair Personal early and takes the open tabs switch once it lands", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?tabsA");
  const engineB = await import("./engine.ts?tabsB");
  await turnOn(a, engineA);
  await a.with(async () => {
    engineA.setOpenTabsSynced("default", true);
    await engineA.syncNow();
  });
  const later = [...folder].find(([, f]) => f.scope === "app" && f.payload.includes('"ptab:'))?.[0];
  assert.ok(later);
  downloading.add(later);
  try {
    await join(b, engineB);
    await b.with(() => assert.deepEqual(engineB.useSync.getState().profiles, {}, "Personal waits too"));
  } finally {
    downloading.delete(later);
  }
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
    assert.equal(S().profiles.default.syncTabs, true, "B's Personal syncs all open tabs like A's");
  });
});

test("#1577: a profile missing from the session at launch keeps its link, is offered back, and comes back under its own sync id", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engine1 = await import("./engine.ts?missing1");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engine1);
  const workSyncId = await a.with(() => syncIdOf(engine1, "Work"));
  assert.ok(workSyncId);
  const full = a.browser;
  const withoutWork = await a.with(() => {
    S().hydrate({ profiles: { default: S().profiles.default }, profileOrder: ["default"], syncMark: S().syncMark });
    useBrowser.setState({ bookmarksReady: { "": true } });
    return S();
  });
  const engine2 = await relaunch(a, "missing2", withoutWork);
  await a.with(async () => {
    await engine2.syncNow();
    assert.equal(syncDoc().profiles[work]?.syncId, workSyncId, "the link stays in sync.json");
    assert.deepEqual(engine2.useSync.getState().remoteProfiles.map((p) => p.name), ["Work"], "Work is offered as Add to This Mac");
  });
  const engine3 = await relaunch(a, "missing3", { ...full, syncMark: a.browser.syncMark });
  await a.with(async () => {
    await engine3.syncNow();
    assert.equal(syncIdOf(engine3, "Work"), workSyncId, "Work syncs under the same id when the session has it again");
    assert.deepEqual(engine3.useSync.getState().remoteProfiles, []);
  });
  assert.equal(new Set(published("prof:").filter((op) => op.v?.n === "Work").map((op) => op.k)).size, 1, "no second Work record");
});

test("#1577: adding a missing profile back from sync gives it its old id, so the session that still has it lines up", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engine1 = await import("./engine.ts?readd1");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engine1);
  const workSyncId = await a.with(() => syncIdOf(engine1, "Work"));
  const withoutWork = await a.with(() => {
    S().hydrate({ profiles: { default: S().profiles.default }, profileOrder: ["default"], syncMark: S().syncMark });
    useBrowser.setState({ bookmarksReady: { "": true } });
    return S();
  });
  const engine2 = await relaunch(a, "readd2", withoutWork);
  await a.with(async () => {
    const added = engine2.addRemoteProfile(workSyncId);
    assert.equal(added, work, "the profile comes back under its old id");
    assert.equal(syncDoc().profiles[work]?.syncId, workSyncId);
    await engine2.syncNow();
  });
});

test("#1577: deleting a profile on this Mac still takes it out of sync", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engine = await import("./engine.ts?deleted");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engine);
  await a.with(async () => {
    S().deleteProfile(work);
    await engine.syncNow();
    assert.equal(syncDoc().profiles[work], undefined, "the link goes once the profile is deleted here");
    assert.equal(engine.useSync.getState().remoteProfiles.some((p) => p.name === "Work"), true, "and Work stays on the other devices, offered to add again");
  });
});

test("#1577: a session restored from an older copy publishes no pin deletions and gets the newer pins back", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?olderA1");
  const engineB = await import("./engine.ts?olderB");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const older = a.browser;
  const engineA2 = await relaunch(a, "olderA2");
  await a.with(async () => {
    pin(["https://two.example/", "https://three.example/"]);
    await engineA2.syncNow();
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"]);
  });
  await b.with(() => S().createWindow({}));
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"], "B has every pin");
  });

  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA3 = await relaunch(a, "olderA3", older);
  await a.with(async () => {
    await engineA3.syncNow();
    await engineA3.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"], "the pins the older session lacked come back");
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted for the other Macs");
  await b.with(async () => {
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"], "B keeps every pin");
  });

  await a.with(async () => {
    const two = Object.values(S().tabs).find((t) => t.pin && t.url === "https://two.example/");
    S().pinTabs([two.id], false);
    await engineA3.syncNow();
  });
  await b.with(async () => {
    await engineB.syncNow();
    assert.equal(pinnedUrls().includes("https://two.example/"), false, "an unpin made after the rebase still reaches the other Mac");
  });
});
