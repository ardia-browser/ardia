import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const KINDS = ["tabs", "pinnedTabs", "favorites"];
const UNREAD = (kind) => ({ kind, code: "unreadable", message: "tabs.db didn't open with Dia's key" });
const GONE = (kind) => ({ kind, code: "empty", message: "Dia keeps no sidebar file in this profile" });
const tab = (url, pinned = false) => ({ url, title: url, pinned, windowIndex: 0, active: false });
const unreadable = (kinds = KINDS) => ({ failed: kinds, warnings: kinds.map(UNREAD) });
let diaProfiles = [];
let reply = () => unreadable();

globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys() {},
    cancelImport() {},
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) => {
      const r = reply();
      if (r === "reject") throw new Error("The import stopped");
      return JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0,
        spaces: [], favorites: [], favicons: [], failed: [], warnings: [], ...r,
      });
    },
    readDiaTabs: async () => JSON.stringify({ profiles: diaProfiles, windowCount: 1, skipped: 0, duplicates: 0, favicons: [] }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { useImportFlow } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const S = () => useBrowser.getState();

async function importDia(dia, { kinds = KINDS, answer = () => unreadable(kinds), withoutKey = false } = {}) {
  diaProfiles = dia;
  reply = answer;
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({
    source: {
      id: "dia", name: "Dia", family: "chromium", requiresExport: false, needsKeychain: true, asksAppForTabs: true,
      profiles: [{ id: "Default", name: "Personal", path: "Default", isDefault: true, available: KINDS, diaSidebar: true, tabsNeedKey: true }],
    },
    sourceProfiles: ["Default"],
    spaces: [],
    target: "default",
    kinds: new Set(kinds),
    step: { name: "choose", error: null },
  });
  await runImport(new Set(kinds), withoutKey);
  await new Promise((r) => setTimeout(r, 5));
  return useImportFlow.getState().step;
}

const failedKinds = (step) => step.failures.map((f) => f.kind).sort();
const personal = (pinned, tabs) => ({ id: "p1", name: "Personal", index: 1, pinned: pinned.map((u) => tab(u, true)), tabs: tabs.map((u) => tab(u)) });
const urls = () => Object.values(S().tabs).map((t) => t.url);
const SIDEBAR_UNREAD = "Dia's sidebar file couldn't be read";

test("when Dia's sidebar file doesn't read, AppleScript recovers the open and pinned tabs but Favorites still fail", async () => {
  const step = await importDia([personal(["https://pinned.dia.example/"], ["https://open.dia.example/"])]);
  assert.equal(step.name, "done");
  assert.deepEqual(failedKinds(step), ["favorites"]);
  assert.equal(step.counts.tabs, 2);
  assert.ok(step.notes.some((n) => n.startsWith(SIDEBAR_UNREAD)));
});

test("when Dia's reply has no profile matching the unreadable one, its tabs stay failed", async () => {
  const step = await importDia([{ id: "p9", name: "Elsewhere", index: 2, pinned: [], tabs: [tab("https://elsewhere.dia.example/")] }]);
  assert.deepEqual(failedKinds(step), ["favorites", "pinnedTabs", "tabs"]);
});

test("a sidebar file that went missing still reports Favorites as not imported", async () => {
  const step = await importDia([personal(["https://pinned.dia.example/"], ["https://open.dia.example/"])], { answer: () => ({ warnings: KINDS.map(GONE) }) });
  assert.deepEqual(failedKinds(step), ["favorites"]);
  assert.equal(step.counts.tabs, 2);
});

test("a pinned-only import whose fallback reply has only open tabs reports the pinned tabs as failed", async () => {
  const step = await importDia([personal([], ["https://open.dia.example/"])], { kinds: ["pinnedTabs"] });
  assert.deepEqual(failedKinds(step), ["pinnedTabs"]);
});

test("a native read that fails outright falls back to Dia the same way and clears what Dia brought", async () => {
  const step = await importDia([personal(["https://pinned.dia.example/"], ["https://open.dia.example/"])], { answer: () => "reject" });
  assert.deepEqual(failedKinds(step), ["favorites"]);
  assert.equal(step.counts.tabs, 2);
  assert.ok(step.notes.some((n) => n.startsWith(SIDEBAR_UNREAD)));
});

test("skipping the keychain on a Favorites-only Dia import says Favorites weren't imported", async () => {
  const step = await importDia([], { kinds: ["favorites"], withoutKey: true, answer: () => ({}) });
  assert.deepEqual(failedKinds(step), ["favorites"]);
  assert.ok(step.notes.some((n) => n.includes("Favorites")));
});

test("a later Dia space keeps its own profile when only it has something of the chosen kinds", async () => {
  const work = { id: "space-work", name: "Work", profileId: "Default", pinned: [], tabs: [], favorites: [tab("https://work.dia.example/", true)] };
  await importDia([], { kinds: ["favorites"], answer: () => ({ spaces: [work], diaSidebar: { primarySpaceId: "space-home" } }) });
  const tile = Object.values(S().tabs).find((t) => t.url === "https://work.dia.example/");
  assert.ok(tile);
  assert.notEqual(tile.profileId, "default");
  assert.equal(S().profiles[tile.profileId].name, "Work");
});

test("an open-tabs read that came from Dia's session instead of its sidebar file falls back to Dia", async () => {
  const step = await importDia([personal([], ["https://open.dia.example/"])], {
    kinds: ["tabs"],
    answer: () => ({ tabs: [tab("https://session.dia.example/")] }),
  });
  assert.ok(urls().includes("https://open.dia.example/"));
  assert.ok(!urls().includes("https://session.dia.example/"));
  assert.ok(step.notes.some((n) => n.startsWith(SIDEBAR_UNREAD)));
});

test("skipping the keychain still reports Favorites when the native read then fails", async () => {
  const step = await importDia([], { kinds: ["favorites"], withoutKey: true, answer: () => "reject" });
  assert.deepEqual(failedKinds(step), ["favorites"]);
  assert.ok(step.notes.some((n) => n.includes("Favorites")));
});
