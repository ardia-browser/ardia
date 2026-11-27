import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const downloading = new Set();
const failing = { writes: 0, stateSeals: false, onWrite: null, onRead: null };
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
      failing.onWrite?.(payload);
      if (failing.writes > 0 && failing.writes--) throw new Error("The sync folder went away mid-write");
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      failing.onRead?.(scope);
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const unknown = here.map(([id]) => id).filter((id) => !known.includes(id));
      const files = here.filter(([id]) => unknown.includes(id) && !downloading.has(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: unknown.filter((id) => downloading.has(id)), damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => {
      if (failing.stateSeals && text.startsWith('{"covers":')) throw new Error("disk full");
      return `sealed:${text}`;
    },
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

function pin(urls, profileId = "default") {
  const w = Object.values(S().windows).find((win) => win.profileId === profileId)?.id ?? S().createWindow({ profileId });
  const tabs = urls.map((url) => S().newTab(w, { url, background: true, profileId }));
  S().pinTabs(tabs, true);
  return tabs;
}

const pinnedUrls = (profileId = "default") =>
  [...Object.values(S().tabs).filter((t) => t.profileId === profileId && t.pin), ...(S().parkedPins[profileId]?.tabs ?? [])].map((t) => t.url).sort();

const withoutProfile = (mac, id, extra = {}) =>
  mac.with(() => {
    const { [id]: _gone, ...profiles } = S().profiles;
    S().hydrate({ profiles, profileOrder: S().profileOrder.filter((p) => p !== id), syncMark: S().syncMark, ...extra });
    useBrowser.setState({ bookmarksReady: { "": true } });
    return S();
  });

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

test("#1577: a backup from the same launch, older than the pins synced since, publishes no pin deletions", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?sameA1");
  const engineB = await import("./engine.ts?sameB");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const backup = a.browser;
  await a.with(async () => {
    pin(["https://two.example/", "https://three.example/"]);
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  assert.notEqual(a.browser.syncMark, backup.syncMark, "the session's mark moved on with what sync saved");
  await b.with(() => S().createWindow({}));
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
  });
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA2 = await relaunch(a, "sameA2", backup);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"]);
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted for the other Macs");
  await b.with(async () => {
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"]);
  });
});

test("#1577: a rebase cut short by a quit or crash right after launch still runs on the next launch, as the launch leaves the marks apart", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?cutA1");
  const engineB = await import("./engine.ts?cutB");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const older = a.browser;
  const engineA2 = await relaunch(a, "cutA2");
  await a.with(async () => {
    pin(["https://two.example/", "https://three.example/"]);
    await engineA2.syncNow();
    await engineA2.syncNow();
  });
  await b.with(() => S().createWindow({}));
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
  });
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;

  a.browser = older;
  const engineA3 = await import("./engine.ts?cutA3");
  await a.with(async () => {
    engineA3.startSync();
    await settle();
  });
  assert.notEqual(JSON.parse(a.docs.get("sync.json")).sessionMark, a.browser.syncMark, "the launch doesn't make the marks match; only the rebase's own progress does");

  const engineA4 = await relaunch(a, "cutA4", a.browser);
  await a.with(async () => {
    await engineA4.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"], "the rebase picks up where it stopped");
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted for the other Macs");
});

test("#1577: a profile added back from sync keeps its scope's sequence, so the other Mac takes its next edit", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?seqA1");
  const engineB = await import("./engine.ts?seqB");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engineA1);
  await a.with(async () => {
    pin(["https://one.example/"], work);
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  const workSyncId = await a.with(() => syncIdOf(engineA1, "Work"));
  await join(b, engineB);
  let workOnB;
  await b.with(async () => {
    workOnB = engineB.addRemoteProfile(workSyncId);
    S().createWindow({ profileId: workOnB });
    await engineB.syncNow();
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(workOnB), ["https://one.example/"]);
  });

  const engineA2 = await relaunch(a, "seqA2", await withoutProfile(a, work));
  await a.with(async () => {
    assert.equal(engineA2.addRemoteProfile(workSyncId), work);
    await engineA2.syncNow();
    await engineA2.syncNow();
    pin(["https://two.example/"], work);
    await engineA2.syncNow();
  });
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(workOnB), ["https://one.example/", "https://two.example/"], "the pin made after adding Work back reaches the other Mac");
  });
});

test("#1577: a profile added back under a new id, because its old one can't be reused, leaves one link to its scope", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engine1 = await import("./engine.ts?fallback1");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engine1);
  const workSyncId = await a.with(() => syncIdOf(engine1, "Work"));
  const engine2 = await relaunch(a, "fallback2", await withoutProfile(a, work, { orphanedProfileData: [work] }));
  await a.with(async () => {
    const added = engine2.addRemoteProfile(workSyncId);
    assert.notEqual(added, work, "the old id's data is waiting to be deleted, so the profile gets a new one");
    const links = Object.entries(syncDoc().profiles).filter(([, link]) => link.syncId === workSyncId);
    assert.deepEqual(links.map(([id]) => id), [added], "one link, under the new id");
    await engine2.syncNow();
    assert.deepEqual(Object.entries(syncDoc().profiles).filter(([, link]) => link.syncId === workSyncId).map(([id]) => id), [added]);
  });
});

test("#1945: a dormant link left waiting for the other devices doesn't keep Settings › Sync on First sync in progress", async () => {
  const { firstSyncRunning } = await import("./syncSummary.ts");
  S().hydrate({});
  const doc = { joining: false, enabled: true, profiles: { gone: { syncId: "w", enabled: true } }, scopes: { app: { joined: true }, "p:w": { awaitRemote: true } } };
  assert.equal(firstSyncRunning(doc), false, "the profile isn't on this Mac, so its scope never runs");
  const here = S().createProfile({ name: "Here" });
  const active = { ...doc, profiles: { [here]: { syncId: "w", enabled: true } } };
  assert.equal(firstSyncRunning(active), true, "a profile that's here and still waiting does count");
});

test("#1577: a cycle that fails after sending a pin still moves the mark on, so a backup without that pin gets a rebase", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?failA1");
  const engineB = await import("./engine.ts?failB");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  await b.with(() => S().createWindow({}));
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
  });
  const backup = a.browser;
  await a.with(async () => {
    pin(["https://two.example/"]);
    failing.writes = 1;
    await engineA1.syncNow();
    assert.equal(engineA1.useSync.getState().status, "stalled", "the batch with the pin couldn't be written");
  });
  failing.writes = 0;
  assert.notEqual(JSON.parse(a.docs.get("sync.json")).sessionMark, backup.syncMark, "the mark moved on though the cycle failed");
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA2 = await relaunch(a, "failA2", backup);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"], "the pin the backup lacked comes back");
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "and isn't deleted for the other Mac");
  await b.with(async () => {
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"]);
  });
});

test("#1577: a restart with the session saved before the rebase repaired it, and sync files saved after, rebases again", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?repairA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const older = a.browser;
  const engineA2 = await relaunch(a, "repairA2");
  await a.with(async () => {
    pin(["https://two.example/"]);
    await engineA2.syncNow();
    await engineA2.syncNow();
  });
  a.browser = older;
  const engineA3 = await import("./engine.ts?repairA3");
  let unrepaired;
  await a.with(async () => {
    engineA3.startSync();
    await settle();
    unrepaired = S();
    await engineA3.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"], "the rebase repaired the session in memory");
  });
  assert.notEqual(JSON.parse(a.docs.get("sync.json")).sessionMark, unrepaired.syncMark, "the session saved before the repair can't match the sync files saved after it");
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA4 = await relaunch(a, "repairA4", unrepaired);
  await a.with(async () => {
    await engineA4.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"]);
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted");
});

test("#1577: a crash right after the outgoing batch reaches the journal still leaves the marks apart for a session without the pin", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?flushA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const backup = a.browser;
  let atCrash = null;
  failing.onWrite = (payload) => {
    if (!atCrash && payload.includes("https://two.example/")) atCrash = new Map(shell.docs);
  };
  try {
    await a.with(async () => {
      pin(["https://two.example/"]);
      await engineA1.syncNow();
    });
  } finally {
    failing.onWrite = null;
  }
  assert.ok(atCrash, "the batch with the pin was being written");
  assert.ok([...atCrash.keys()].some((name) => /^sync-journal-\d+\.nns$/.test(name)), "its journal entry was already on disk");
  assert.notEqual(JSON.parse(atCrash.get("sync.json")).sessionMark, backup.syncMark, "and sync.json had moved its mark on before it");
  a.docs = atCrash;
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA2 = await relaunch(a, "flushA2", backup);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"]);
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted");
});

test("#1577: the first launch after upgrading, with a sync base but no mark yet, rebases a session restored without the newer pins", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?legacyA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const older = { ...a.browser, syncMark: "" };
  await a.with(async () => {
    pin(["https://two.example/"]);
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  const legacy = JSON.parse(a.docs.get("sync.json"));
  delete legacy.sessionMark;
  a.docs.set("sync.json", JSON.stringify(legacy));
  const tombstonesBefore = published("pin:t:").filter((op) => op.v === null).length;
  const engineA2 = await relaunch(a, "legacyA2", older);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"], "the pin the older session lacked comes back");
  });
  assert.equal(published("pin:t:").filter((op) => op.v === null).length, tombstonesBefore, "no pin is deleted");
});

test("#1577: a pin still waiting to be sent when its profile went missing comes back with the profile and reaches the other Mac", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?queuedA1");
  const engineB = await import("./engine.ts?queuedB");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engineA1);
  await a.with(async () => {
    pin(["https://one.example/"], work);
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  const workSyncId = await a.with(() => syncIdOf(engineA1, "Work"));
  await a.with(async () => {
    pin(["https://queued.example/"], work);
    failing.writes = 1;
    await engineA1.syncNow();
  });
  failing.writes = 0;
  const engineA2 = await relaunch(a, "queuedA2", await withoutProfile(a, work));
  await a.with(async () => {
    assert.equal(engineA2.addRemoteProfile(workSyncId), work);
    S().createWindow({ profileId: work });
    await engineA2.syncNow();
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(work), ["https://one.example/", "https://queued.example/"], "the queued pin is back here too");
  });
  await join(b, engineB);
  await b.with(async () => {
    const workOnB = engineB.addRemoteProfile(workSyncId);
    S().createWindow({ profileId: workOnB });
    await engineB.syncNow();
    await engineB.syncNow();
    assert.deepEqual(pinnedUrls(workOnB), ["https://one.example/", "https://queued.example/"]);
  });
});

const tombstones = () => published("pin:t:").filter((op) => op.v === null).length;

test("#1577: a crash after the app scope moved the mark on, before a profile scope's first pull, still rebases that profile", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?scopesA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const older = a.browser;
  const engineA2 = await relaunch(a, "scopesA2");
  await a.with(async () => {
    pin(["https://two.example/"]);
    await engineA2.syncNow();
    await engineA2.syncNow();
  });
  a.browser = older;
  const engineA3 = await import("./engine.ts?scopesA3");
  let atCrash = null;
  let sessionAtCrash = null;
  await a.with(async () => {
    engineA3.startSync();
    await settle();
    failing.onRead = (scope) => {
      if (!atCrash && scope.startsWith("p:")) {
        atCrash = new Map(shell.docs);
        sessionAtCrash = S();
      }
    };
    try {
      await engineA3.syncNow();
    } finally {
      failing.onRead = null;
    }
  });
  assert.ok(atCrash, "the profile scope was about to pull");
  const saved = JSON.parse(atCrash.get("sync.json"));
  assert.equal(saved.sessionMark, sessionAtCrash.syncMark, "the app scope had already made the marks match");
  assert.ok(Object.keys(saved.rebaseScopes ?? {}).some((name) => name.startsWith("p:")), "but the profile's rebase was owed in sync.json");
  a.docs = atCrash;
  const before = tombstones();
  const engineA4 = await relaunch(a, "scopesA4", sessionAtCrash);
  await a.with(async () => {
    await engineA4.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"], "the profile still rebases");
  });
  assert.equal(tombstones(), before, "and deletes no pin");
});

test("#1577: a pin sent while quitting moves the mark in sync.json, leaving the closing session alone, so an older backup still rebases", async () => {
  folder.clear();
  downloading.clear();
  const quit = await import("../app/quit.ts");
  const a = new Mac();
  const engineA1 = await import("./engine.ts?quitA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const backup = a.browser;
  let storeMark;
  await a.with(async () => {
    pin(["https://two.example/"]);
    storeMark = S().syncMark;
    quit.setQuitting(true);
    try {
      await engineA1.syncNow();
    } finally {
      quit.setQuitting(false);
    }
    assert.equal(S().syncMark, storeMark, "the session store, already saved for the quit, isn't touched");
  });
  assert.ok(published("pin:t:").some((op) => op.v?.u === "https://two.example/"), "the pin went out while quitting");
  assert.notEqual(JSON.parse(a.docs.get("sync.json")).sessionMark, backup.syncMark, "sync.json's mark moved before it did");
  const before = tombstones();
  const engineA2 = await relaunch(a, "quitA2", backup);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"]);
  });
  assert.equal(tombstones(), before, "no pin is deleted");
});

test("#1577: when sync.json can't be saved, the batch that would need its new mark isn't journalled or sent", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?docFailA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const journalHolds = (text) => [...a.docs].some(([name, contents]) => /^sync-journal-\d+\.nns$/.test(name) && contents.includes(text));
  shell.refusedSaves.of.add("sync.json");
  try {
    await a.with(async () => {
      pin(["https://two.example/"]);
      await engineA1.syncNow();
      assert.equal(engineA1.useSync.getState().status, "stalled");
    });
  } finally {
    shell.refusedSaves.of.delete("sync.json");
  }
  assert.equal(journalHolds("two.example"), false, "nothing about the pin reached the journal");
  assert.equal(published("pin:t:").some((op) => op.v?.u === "https://two.example/"), false, "or the folder");
  await a.with(async () => {
    await engineA1.syncNow();
    assert.equal(engineA1.useSync.getState().status, "updated");
  });
  assert.ok(published("pin:t:").some((op) => op.v?.u === "https://two.example/"), "once sync.json saves, the pin goes out");
});

test("#1577: a second recovery doesn't take the first one's finished rebase for its own, even when the marks match after a crash", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?secondA1");
  await a.with(() => pin(["https://one.example/"]));
  await turnOn(a, engineA1);
  const first = a.browser;
  const engineA2 = await relaunch(a, "secondA2");
  await a.with(async () => {
    pin(["https://two.example/"]);
    await engineA2.syncNow();
    await engineA2.syncNow();
  });
  const engineA3 = await relaunch(a, "secondA3", first);
  await a.with(async () => {
    await engineA3.syncNow();
    await engineA3.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://two.example/"], "the first recovery finished");
  });
  assert.equal(JSON.parse(a.docs.get("sync.json")).rebaseScopes, undefined, "and owes nothing");
  const second = a.browser;
  await a.with(async () => {
    pin(["https://three.example/"]);
    await engineA3.syncNow();
    await engineA3.syncNow();
  });
  a.browser = second;
  const engineA4 = await import("./engine.ts?secondA4");
  let atCrash = null;
  let sessionAtCrash = null;
  await a.with(async () => {
    engineA4.startSync();
    await settle();
    failing.onRead = (scope) => {
      if (!atCrash && scope.startsWith("p:")) {
        atCrash = new Map(shell.docs);
        sessionAtCrash = S();
      }
    };
    try {
      await engineA4.syncNow();
    } finally {
      failing.onRead = null;
    }
  });
  assert.ok(atCrash);
  const saved = JSON.parse(atCrash.get("sync.json"));
  assert.ok(Object.keys(saved.rebaseScopes ?? {}).some((name) => name.startsWith("p:")), "the profile's part of the second recovery is owed");
  a.docs = atCrash;
  const before = tombstones();
  const engineA5 = await relaunch(a, "secondA5", { ...sessionAtCrash, syncMark: saved.sessionMark });
  await a.with(async () => {
    await engineA5.syncNow();
    assert.deepEqual(pinnedUrls(), ["https://one.example/", "https://three.example/", "https://two.example/"], "the profile rebases for the second recovery");
  });
  assert.equal(tombstones(), before, "and deletes no pin");
});

test("#1577: a profile added back while one of its files downloads, then a crash before a full checkpoint, deletes no pin on restart", async () => {
  folder.clear();
  downloading.clear();
  const a = new Mac();
  const engineA1 = await import("./engine.ts?resetA1");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engineA1);
  await a.with(async () => {
    pin(["https://one.example/"], work);
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  const workSyncId = await a.with(() => syncIdOf(engineA1, "Work"));
  const pinFile = [...folder].find(([, f]) => f.scope === `p:${workSyncId}` && f.payload.includes("one.example"))?.[0];
  assert.ok(pinFile);
  const engineA2 = await relaunch(a, "resetA2", await withoutProfile(a, work));
  downloading.add(pinFile);
  let restored;
  try {
    await a.with(async () => {
      assert.equal(engineA2.addRemoteProfile(workSyncId), work);
      S().createWindow({ profileId: work });
      await engineA2.syncNow();
      restored = S();
    });
  } finally {
    downloading.delete(pinFile);
  }
  const before = tombstones();
  const engineA3 = await relaunch(a, "resetA3", restored);
  await a.with(async () => {
    await engineA3.syncNow();
    await engineA3.syncNow();
    assert.deepEqual(pinnedUrls(work), ["https://one.example/"], "the pin comes back once its file is read");
  });
  assert.equal(tombstones(), before, "no pin is deleted after the restart");
});
