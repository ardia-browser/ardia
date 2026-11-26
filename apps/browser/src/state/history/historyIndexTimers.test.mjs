import assert from "node:assert/strict";
import { mock, test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { INDEX_WHEN_QUIET_MS, historyIndexesPending, reloadHistory, startHistory } = await import("./engineSync.ts");
const { historyApplyStats, historyListIndexed } = await import("./historyChanges.ts");
const { setQuitting } = await import("../app/quit.ts");
const { markProfileUnloaded, openProfile } = await import("../profiles/profileLoading.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const PROFILES = {
  default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
  work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 },
};
const listOf = (engine) => S().history[engine]?.list ?? [];
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function started() {
  mock.timers.enable({ apis: ["setTimeout"] });
  S().hydrate({ profiles: PROFILES, profileOrder: ["default", "work"] });
  stub.docs.clear();
  stub.historyDbs.clear();
  for (const engine of ["", "work"]) openProfile(engine);
  const now = Date.now();
  for (const engine of ["", "work"]) {
    const db = stub.chromeHistory(engine);
    for (let i = 0; i < 50; i++) db.set(`https://${engine || "home"}${i}.example/`, { title: `P${i}`, visits: [now - 60_000 - i * 1000] });
  }
  const stop = startHistory();
  await reloadHistory();
  await settle();
  return stop;
}

const visit = (engine, i) => stub.chromeVisit(engine, `https://visit${i}.example/`, `V${i}`, Date.now() + i);

const finish = (stop) => {
  stop();
  setQuitting(false);
  mock.timers.reset();
};

async function heldReload(engine) {
  let release;
  stub.heldHistoryQueries.reply = new Promise((resolve) => (release = resolve));
  const reload = reloadHistory();
  await settle();
  stub.chromeHistoryEvent({ kind: "modified", profile: engine, rows: [{ url: `https://${engine || "home"}3.example/`, title: "retitled during a held read", visits: 1 }] });
  await settle();
  return {
    release: async () => {
      stub.heldHistoryQueries.reply = null;
      release();
      await reload;
      await settle();
    },
  };
}

test("a profile's list is indexed once its history has been quiet for 2 s, not before", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const list = listOf("");
    assert.equal(historyListIndexed(list), false);
    mock.timers.tick(INDEX_WHEN_QUIET_MS - 1);
    assert.equal(historyListIndexed(list), false, "not before the quiet time");
    mock.timers.tick(1);
    assert.equal(historyListIndexed(list), true);
  } finally {
    finish(stop);
  }
});

test("two profiles changed in the same batch each get their own index", async () => {
  const stop = await started();
  try {
    visit("", 1);
    visit("work", 2);
    await settle();
    const home = listOf("");
    const work = listOf("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(home), true, "Personal");
    assert.equal(historyListIndexed(work), true, "Work");
  } finally {
    finish(stop);
  }
});

test("clearing a profile's history drops the build pending for the list it replaced", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const before = listOf("");
    S().clearHistory("default");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(before), false, "the replaced list is never indexed");
    assert.equal(historyListIndexed(listOf("")), false, "and nothing is built for the cleared one");
  } finally {
    finish(stop);
  }
});

test("stopping history sync clears every pending timer, and the clock passing builds nothing", async () => {
  const stop = await started();
  try {
    visit("", 1);
    visit("work", 2);
    await settle();
    const home = listOf("");
    const work = listOf("work");
    assert.equal(historyIndexesPending(), 2);
    const builds = historyApplyStats.indexBuilds;
    stop();
    assert.equal(historyIndexesPending(), 0, "stop clears both profiles' timers");
    mock.timers.tick(INDEX_WHEN_QUIET_MS * 2);
    assert.equal(historyApplyStats.indexBuilds, builds, "no build after stop");
    assert.equal(historyListIndexed(home), false);
    assert.equal(historyListIndexed(work), false);
  } finally {
    setQuitting(false);
    mock.timers.reset();
  }
});

test("a change that lands while a reload's read is open is replayed onto the read list, which is then indexed once quiet", async () => {
  const stop = await started();
  try {
    const reload = reloadHistory();
    stub.chromeHistoryEvent({ kind: "modified", profile: "", rows: [{ url: "https://home3.example/", title: "retitled during the read", visits: 1 }] });
    await reload;
    await settle();
    const list = listOf("");
    assert.ok(list.some((h) => h.title === "retitled during the read"), "the replayed change is in the read list");
    assert.equal(historyListIndexed(list), false);
    assert.ok(historyIndexesPending() >= 1, "a quiet-time build is scheduled for it");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(list), true);
    const indexed = historyApplyStats.indexed;
    stub.chromeHistoryEvent({ kind: "modified", profile: "", rows: [{ url: "https://home4.example/", title: "after", visits: 1 }] });
    await settle();
    assert.equal(historyApplyStats.indexed, indexed + 1, "the next change takes the indexed path");
  } finally {
    finish(stop);
  }
});

test("a profile unloaded while its build is pending isn't indexed; the other profile still is", async () => {
  const stop = await started();
  try {
    visit("", 1);
    visit("work", 2);
    await settle();
    const home = listOf("");
    const work = listOf("work");
    markProfileUnloaded("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(work), false, "unloaded");
    assert.equal(historyListIndexed(home), true, "still loaded");
  } finally {
    finish(stop);
  }
});

test("once quitting starts nothing pending is built, and a batch during the quit schedules nothing", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const before = listOf("");
    setQuitting(true);
    visit("work", 2);
    await settle();
    const during = listOf("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(before), false);
    assert.equal(historyListIndexed(during), false);
  } finally {
    finish(stop);
  }
});

test("a held reload that finishes after history sync stopped is ignored: no list, no timer, no build", async () => {
  const stop = await started();
  try {
    const before = listOf("work");
    const held = await heldReload("work");
    stop();
    assert.equal(historyIndexesPending(), 0);
    const builds = historyApplyStats.indexBuilds;
    await held.release();
    assert.equal(historyIndexesPending(), 0, "the stale read schedules nothing");
    assert.equal(listOf("work"), before, "and sets no list");
    mock.timers.tick(INDEX_WHEN_QUIET_MS * 2);
    assert.equal(historyApplyStats.indexBuilds, builds, "no build");
  } finally {
    stub.heldHistoryQueries.reply = null;
    setQuitting(false);
    mock.timers.reset();
  }
});

test("a held reload that finishes after its profile unloaded is ignored, and reopening the profile reads it again", async () => {
  const stop = await started();
  try {
    const before = listOf("work");
    const held = await heldReload("work");
    markProfileUnloaded("work");
    assert.equal(historyIndexesPending(), 0);
    const builds = historyApplyStats.indexBuilds;
    await held.release();
    assert.equal(historyIndexesPending(), 0, "the stale read schedules nothing");
    assert.equal(listOf("work"), before, "and sets no list");
    mock.timers.tick(INDEX_WHEN_QUIET_MS * 2);
    assert.equal(historyApplyStats.indexBuilds, builds, "no build");
    stub.chromeVisit("work", "https://while-unloaded.example/", "Unloaded", Date.now());
    await settle();
    assert.ok(!listOf("work").some((h) => h.url === "https://while-unloaded.example/"), "an unloaded profile's list isn't touched");
    openProfile("work");
    await settle();
    assert.ok(listOf("work").some((h) => h.url === "https://while-unloaded.example/"), "reopened: read again from Chrome");
  } finally {
    stub.heldHistoryQueries.reply = null;
    finish(stop);
  }
});
