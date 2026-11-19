import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, docOnDisk, folder, journalParts, pausedStart, quit, remoteFolder, retire, S, sealedFiles, setConsentPeriod, settle, shell, stub, syncedProfile, syncNative, takeSyncPauseCounts, timersRun, writes } from "./fixtures/pausedSync.mjs";

const documents = shell.shellNativeModules.ArdiaDocuments;
const stockSave = documents.saveDocument;
const syncWrites = () => writes.filter((name) => name.startsWith("sync"));
const ui = (engine) => engine.useSync.getState();

function refuseSyncSave(when, how = "reject") {
  documents.saveDocument = (name, contents) => {
    if (name === "sync.json" && when(JSON.parse(contents))) {
      if (how === "throw") throw new Error("save refused");
      return Promise.reject(new Error("disk full"));
    }
    return stockSave(name, contents);
  };
}
const allowSyncSave = () => void (documents.saveDocument = stockSave);

test("a failed Resume leaves no extension watcher behind", async () => {
  S().hydrate({});
  const seeded = new Map([["sync.json", JSON.stringify({ v: 1, enabled: true, deviceId: "ext-device", folder: "/sync", profiles: { default: { syncId: "ext-profile", enabled: true } } })]]);
  const engine = await pausedStart(seeded);
  const reads = () => shell.engineCalls.filter(({ domain, verb }) => domain === "extensions" && verb === "syncState").length;
  stub.chainAnswer = "unavailable";
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "paused");
  const seen = reads();
  shell.emitEvent("extensions.sync", { profile: "", id: "fixture", kind: "installed" });
  await settle();
  assert.equal(reads(), seen, "an extension event after the failed Resume reads nothing");
});

test("a Resume that finds no sync data in the folder stays paused and resets nothing", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const before = sealedFiles();
  const remote = remoteFolder();
  stub.chainAnswer = "missing";
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "paused");
  assert.equal(ui(engine).enabled, true);
  assert.match(ui(engine).error ?? "", /can’t find its sync data in the sync folder/);
  assert.equal(calls.forget, 0, "the key is kept");
  assert.deepEqual(sealedFiles(), before, "the state and journal parts are kept");
  assert.equal(remoteFolder(), remote);
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.equal(docOnDisk().deviceId, "devP");
});

test("outside a pause a missing chain still resets as before", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk, { recoveredStart: false });
  stub.chainAnswer = "missing";
  await engine.syncNow();
  await settle();
  assert.equal(ui(engine).status, "reset");
  assert.equal(calls.forget, 1);
  assert.equal(ui(engine).enabled, false);
});

test("Stop Syncing while paused turns sync off, clears the pause, and leaves the sync folder alone", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const remote = remoteFolder();
  await engine.stopSync();
  await settle();
  assert.equal(ui(engine).status, "off");
  assert.equal(ui(engine).enabled, false);
  assert.equal(calls.chainStatus, 0, "no retiring cycle");
  assert.equal(calls.write, 0);
  assert.equal(calls.deleteChain, 0);
  assert.equal(remoteFolder(), remote);
  assert.equal(docOnDisk().enabled, false);
  assert.equal(docOnDisk().pausedByGuard, undefined);
});

test("asking Stop to delete the sync data while paused deletes nothing from the folder", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const remote = remoteFolder();
  await engine.stopSync({ deleteData: true });
  await settle();
  assert.equal(ui(engine).status, "off");
  assert.equal(calls.deleteChain, 0);
  assert.equal(remoteFolder(), remote);
});

test("while paused every setup, settings and send function refuses and writes nothing", async () => {
  const { disk } = await syncedProfile();
  const w = S().createWindow({ url: "https://send.example/" });
  const tabId = Object.values(S().tabs).find((t) => t.windowId === w).id;
  const engine = await pausedStart(disk);
  const docBefore = shell.docs.get("sync.json");
  const before = sealedFiles();
  const remote = remoteFolder();
  const types = ui(engine).types;
  writes.length = 0;
  stub.timers = [];
  assert.ok("error" in (await engine.turnOnSync("/sync")), "turnOnSync");
  assert.ok("error" in (await engine.enterRecoveryPhrase("/sync", "the words")), "the new-device phrase");
  assert.equal(calls.enterPhrase, 0);
  assert.equal(await engine.chooseSyncFolder(), null, "chooseSyncFolder");
  assert.equal(calls.chooseFolder, 0);
  assert.equal(engine.addRemoteProfile("p:other"), null);
  assert.equal(engine.removeRemoteProfile("p:other"), false);
  assert.equal(engine.removeSyncedDevice("devOther"), false);
  engine.setTypeSynced("history", false);
  engine.setProfileSynced("default", false);
  engine.setOpenTabsSynced("default", true);
  assert.equal(S().profiles.default.syncTabs, undefined, "the profile's open-tabs choice is left as it was");
  engine.adoptProfileTheme("default");
  await engine.syncNow();
  assert.equal(engine.sendTab(tabId, "devOther"), false, "a tab isn't queued for sending");
  assert.deepEqual(engine.sendTargets("default"), []);
  await settle();
  assert.deepEqual(ui(engine).types, types);
  assert.deepEqual(syncWrites(), []);
  assert.equal(shell.docs.get("sync.json"), docBefore);
  assert.deepEqual(sealedFiles(), before);
  assert.equal(remoteFolder(), remote);
  await timersRun();
  assert.equal(calls.chainStatus, 0);
  assert.equal(calls.unlock, 0);
});

test("a refused pause write still pauses this start", async () => {
  const { disk } = await syncedProfile();
  refuseSyncSave((doc) => doc.pausedByGuard === true);
  try {
    const engine = await pausedStart(disk);
    assert.equal(ui(engine).status, "paused");
    assert.equal(calls.unlock, 0);
    assert.equal(docOnDisk().pausedByGuard, undefined, "the write didn't land");
  } finally {
    allowSyncSave();
  }
});

for (const how of ["reject", "throw"]) {
  test(`a clear that fails to save (${how}) stays paused, counts no completion, and Resume works again`, async () => {
    const { disk } = await syncedProfile();
    const engine = await pausedStart(disk);
    takeSyncPauseCounts();
    refuseSyncSave((doc) => doc.enabled && !doc.pausedByGuard, how);
    try {
      await engine.resumeSync();
      await settle();
    } finally {
      allowSyncSave();
    }
    assert.equal(ui(engine).status, "paused");
    assert.ok(ui(engine).error);
    assert.equal(docOnDisk().pausedByGuard, true);
    assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 1, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
    await engine.resumeSync();
    await settle();
    assert.equal(calls.unlock, 2, "the second press runs");
    assert.equal(ui(engine).status, "updated");
    assert.equal(docOnDisk().pausedByGuard, undefined);
    assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 1, sync_resumes_completed: 1, sync_loads_refused_damaged: 0 });
    await retire(engine);
  });
}

test("quitting waits for a Resume in flight, and that Resume stands down as failed", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const remote = remoteFolder();
  let release;
  syncNative.chainStatus = () => new Promise((resolve) => (release = resolve));
  const resume = engine.resumeSync();
  await settle();
  quit.setQuitting(true);
  writes.length = 0;
  let quitDone = false;
  const quitting = quit.finishQuitSaves(5_000).then(() => (quitDone = true));
  await settle();
  assert.equal(quitDone, false, "the quit's sync save waits for the Resume");
  release("ok");
  await resume;
  await quitting;
  await settle();
  assert.equal(ui(engine).status, "paused");
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.equal(remoteFolder(), remote, "nothing is uploaded once quitting began");
  assert.deepEqual(writes.filter((name) => name.startsWith("sync-")), []);
});

test("a checkpoint still sealing when a Resume fails never lands, quitting included", async () => {
  const { disk } = await syncedProfile();
  disk.set("sync-journal-1.nns", disk.get("sync-journal-1.nns") + " ".repeat(1_000_000));
  const engine = await pausedStart(disk);
  const partsBefore = journalParts();
  stub.chainAnswer = "unavailable";
  const seal = syncNative.sealLocal;
  let release = null;
  syncNative.sealLocal = async (text) => {
    if (text.startsWith('{"covers":')) await new Promise((resolve) => (release = resolve));
    return seal(text);
  };
  writes.length = 0;
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "paused");
  quit.setQuitting(true);
  await quit.finishQuitSaves(5_000);
  release?.();
  await settle();
  assert.ok(!writes.includes("sync-state.nns"), "no checkpoint is written");
  assert.deepEqual(journalParts(), partsBefore, "and no part is removed");
});

test("a second Resume after a failed one never rewinds a sequence on disk or uploads a batch twice", async () => {
  const { disk, seqs } = await syncedProfile();
  const engine = await pausedStart(disk);
  const stock = { ...syncNative };
  let stage = "fail later scope";
  syncNative.read = async (...args) => {
    if (stage === "fail later scope" && args[1] !== "app") throw new Error("later scope offline");
    return stock.read(...args);
  };
  syncNative.sealLocal = async (plain) => {
    if (stage !== "healthy" && (plain.includes('"changes":') || plain.startsWith('{"covers":'))) throw new Error("metadata write failed");
    return stock.sealLocal(plain);
  };
  syncNative.chainStatus = async () => (stage === "offline" ? "unavailable" : stock.chainStatus());
  const highest = { ...seqs };
  const rewound = [];
  const set = shell.docs.set;
  shell.docs.set = function (name, contents) {
    if (name === "sync.json") {
      for (const [scope, seq] of Object.entries(JSON.parse(contents).seqs ?? {})) {
        if (seq < (highest[scope] ?? 0)) rewound.push({ scope, seq, was: highest[scope] });
        highest[scope] = Math.max(seq, highest[scope] ?? 0);
      }
    }
    return set.call(this, name, contents);
  };
  try {
    S().updateSettings({ warnBeforeQuitting: false });
    await engine.resumeSync();
    await settle();
    assert.equal(ui(engine).status, "paused");
    assert.equal(docOnDisk().seqs.app, seqs.app + 1, "the first attempt published a batch");
    stage = "offline";
    await engine.resumeSync();
    await settle();
    assert.equal(ui(engine).status, "paused");
    stage = "healthy";
    await engine.resumeSync();
    await settle();
    assert.equal(ui(engine).status, "updated");
  } finally {
    shell.docs.set = set;
  }
  assert.deepEqual(rewound, [], "no sequence goes backwards on disk");
  const published = new Map();
  for (const [id, file] of folder) {
    const payload = JSON.parse(file.payload);
    if (payload.kind !== "log") continue;
    const key = `${file.scope} ${payload.device} ${payload.seq}`;
    assert.ok(!published.has(key), `${key} was uploaded twice (${published.get(key)} and ${id})`);
    published.set(key, id);
  }
  await retire(engine);
});

test("after a failed Resume the summary shows no devices, profiles or tabs and nothing stays loaded", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  const stock = { ...syncNative };
  syncNative.read = async (...args) => {
    if (args[1] !== "app") throw new Error("later scope offline");
    return stock.read(...args);
  };
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "paused");
  assert.equal(ui(engine).paused, true);
  assert.deepEqual(ui(engine).devices, []);
  assert.deepEqual(ui(engine).remoteTabs, {});
  assert.deepEqual(ui(engine).remoteProfiles, []);
  assert.deepEqual(engine.appScopeRecords(), {}, "the loaded scopes are dropped");
});

test("a tab closed while paused stays closed after Resume", async () => {
  const url = "https://closed-while-paused.example/";
  let tabId = null;
  const { disk } = await syncedProfile({
    build: async (first) => {
      const w = S().createWindow({});
      tabId = S().newTab(w, { url, background: true });
      S().newTab(w, { url: "https://still-open.example/" });
      await first.syncNow();
      first.setOpenTabsSynced("default", true);
      await first.syncNow();
    },
  });
  assert.ok([...folder.values()].some(({ payload }) => payload.includes(url)), "the tab was synced");
  const engine = await pausedStart(disk);
  S().closeTab(tabId);
  assert.ok(!Object.values(S().tabs).some((t) => t.url === url));
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "updated");
  assert.ok(!Object.values(S().tabs).some((t) => t.url === url), "the closed tab doesn't come back");
  await retire(engine);
});

test("an ordinary start after a successful Resume isn't paused", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  await engine.resumeSync();
  await settle();
  assert.equal(ui(engine).status, "updated");
  const later = await pausedStart(new Map(shell.docs), { recoveredStart: false });
  assert.notEqual(ui(later).status, "paused");
  assert.equal(calls.unlock, 1);
  await retire(later);
});

test("the phrase continuation counts with the token taken at the press, not a new one", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk, { keyMissing: true });
  takeSyncPauseCounts();
  setConsentPeriod(false, null);
  try {
    await engine.resumeSync();
    assert.equal(ui(engine).status, "locked");
    let accept;
    const enter = syncNative.enterPhrase;
    syncNative.enterPhrase = async (...args) => {
      await new Promise((resolve) => (accept = resolve));
      return enter(...args);
    };
    const submitted = engine.enterRecoveryPhrase("/sync", "the words");
    await settle();
    setConsentPeriod(true, "enabled-mid-phrase");
    accept();
    await submitted;
    await settle();
    assert.equal(ui(engine).status, "updated");
    assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_paused_after_unsettled_starts: 0, sync_resumes: 0, sync_resumes_completed: 0, sync_loads_refused_damaged: 0 });
  } finally {
    setConsentPeriod(true, "sync-pause-test");
  }
  await retire(engine);
});
