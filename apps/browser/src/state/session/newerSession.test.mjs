import assert from "node:assert/strict";
import { test } from "node:test";
import { docs, unlandedDocuments } from "../../test-native/index.ts";
import { flushPersistence, loadSession, newerDocumentsKeptAsideAtLaunch, resumePersistence, startPersistence, SESSION_VERSION } from "./persist.ts";
import { useBrowser } from "../browser/store.ts";

const NEWER = SESSION_VERSION + 1;
const ASIDE = `session.v${NEWER}.json`;

function savedByNewerBuild(url) {
  return JSON.stringify({
    profiles: { p1: { id: "p1", name: "Work" } },
    windows: [{ id: "w1", profileId: "p1", tabIds: ["t1"], activeTabIds: { p1: "t1" } }],
    windowOrder: ["w1"],
    tabs: [{ id: "t1", windowId: "w1", profileId: "p1", url }],
    version: NEWER,
  });
}

const landings = () => new Promise((resolve) => setImmediate(resolve));

async function launchOlderBuild() {
  const stop = startPersistence();
  useBrowser.getState().createWindow({ url: "about:blank" });
  await landings();
  flushPersistence();
  stop();
  resumePersistence();
  return JSON.parse(docs.get("session.json"));
}

test("a session saved by a newer build is kept aside before this build starts fresh over it", async () => {
  docs.clear();
  const newer = savedByNewerBuild("https://example.com/");
  docs.set("session.json", newer);
  const written = await launchOlderBuild();
  assert.equal(written.version, SESSION_VERSION);
  assert.ok(!written.tabs.some((t) => t.url === "https://example.com/"));
  assert.equal(docs.get(ASIDE), newer);
  assert.equal(newerDocumentsKeptAsideAtLaunch(), 1);
});

test("relaunching over the same newer session makes no second copy", async () => {
  docs.clear();
  const newer = savedByNewerBuild("https://example.com/");
  docs.set(ASIDE, newer);
  docs.set("session.json", newer);
  await launchOlderBuild();
  assert.deepEqual([...docs.keys()].filter((name) => name.startsWith("session.")).sort(), ["session.json", ASIDE]);
  assert.equal(newerDocumentsKeptAsideAtLaunch(), 0);
});

test("a newer build's later session is kept next to the earlier copy, not dropped or written over it", async () => {
  docs.clear();
  const first = savedByNewerBuild("https://example.com/first");
  const second = savedByNewerBuild("https://example.com/second");
  docs.set(ASIDE, first);
  docs.set("session.json", second);
  await launchOlderBuild();
  assert.equal(docs.get(ASIDE), first);
  assert.equal(docs.get(`session.v${NEWER}-2.json`), second);
  assert.equal(newerDocumentsKeptAsideAtLaunch(), 1);
});

test("the session isn't saved over the newer one until its copy is on disk", async () => {
  docs.clear();
  const newer = savedByNewerBuild("https://example.com/");
  docs.set("session.json", newer);
  unlandedDocuments.add(ASIDE);
  const stop = startPersistence();
  useBrowser.getState().createWindow({ url: "about:blank" });
  await landings();
  flushPersistence();
  assert.equal(docs.get("session.json"), newer);
  unlandedDocuments.delete(ASIDE);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await landings();
  flushPersistence();
  stop();
  resumePersistence();
  assert.equal(JSON.parse(docs.get("session.json")).version, SESSION_VERSION);
});

test("a session at this build's version or older loads as before and nothing is kept aside", () => {
  for (const version of [SESSION_VERSION, SESSION_VERSION - 1]) {
    docs.clear();
    docs.set("session.json", JSON.stringify({ ...JSON.parse(savedByNewerBuild("https://example.com/")), version }));
    const loaded = loadSession();
    assert.ok(Object.values(loaded.tabs).some((t) => t.url === "https://example.com/"));
    assert.deepEqual([...docs.keys()].filter((name) => name.startsWith("session.v")), []);
  }
});

test("downloads saved by a newer build are kept aside too", () => {
  docs.clear();
  const downloads = JSON.stringify({ downloads: [{ id: "d1", state: "finished", url: "https://example.com/x" }], version: 99 });
  docs.set("session.json", JSON.stringify({ version: SESSION_VERSION, windows: [], tabs: [] }));
  docs.set("downloads.json", downloads);
  loadSession();
  assert.equal(docs.get("downloads.v99.json"), downloads);
});

test("a session that can't be read isn't copied", () => {
  for (const text of ["{", "[]", JSON.stringify({ version: "99" }), JSON.stringify({ version: -1 })]) {
    docs.clear();
    docs.set("session.json", text);
    loadSession();
    assert.deepEqual([...docs.keys()], ["session.json"]);
  }
});
