import assert from "node:assert/strict";
import { mock, test } from "node:test";

const { useBrowser } = await import("../browser/store.ts");
const { versionedJson } = await import("../../lib/savedDocument.ts");
const { SESSION_VERSION, flushPersistence, loadSession, startPersistence } = await import("./persist.ts");
const { cosmeticTabsChange, savedDocumentJson, savedDocumentValue } = await import("./documentJson.ts");
const { SESSION_DOCUMENT } = await import("./sessionDocument.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const oldJson = () => versionedJson(savedDocumentValue(SESSION_DOCUMENT, S()), SESSION_VERSION);
const newJson = () => savedDocumentJson(SESSION_DOCUMENT, S());
const sameAsBefore = (label) => assert.equal(newJson(), oldJson(), label);

const TITLES = ['Plain', 'Quote " and \\ backslash', "Emoji 🐙 and 中文", "Line separator ", "Tab\tand\nnewline", "</script>"];

function session(version, tabs) {
  const windows = [
    { id: "w1", profileId: "default", tabIds: tabs.filter((t) => t.windowId === "w1").map((t) => t.id), activeTabIds: { default: "t0" } },
    { id: "w2", profileId: "default", tabIds: tabs.filter((t) => t.windowId === "w2").map((t) => t.id), activeTabIds: { default: "t1" } },
  ];
  return JSON.stringify({ version, profiles: { default: { id: "default", name: "Personal" } }, profileOrder: ["default"], windows, windowOrder: ["w1", "w2"], tabs, groups: [{ id: "g1", windowId: "w1", profileId: "default", name: "Work", tabIds: ["t2", "t4"], icon: null, color: null }], settings: {} });
}

function tabsAt(n, legacy) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    windowId: i % 3 ? "w1" : "w2",
    profileId: "default",
    url: `https://site${i}.example/page?q=${i}`,
    title: TITLES[i % TITLES.length] + ` ${i}`,
    favicon: i % 4 ? `data:image/png;base64,${"A".repeat(40 + i)}` : null,
    createdAt: 1_700_000_000_000 + i,
    lastActiveAt: 1_700_000_100_000 + i,
    ...(legacy ? { pinned: i % 7 === 0, ...(i % 5 === 0 ? { unloaded: true, wakeAdoptId: `restore:${i}` } : { navigation: { url: "x", seq: i } }) } : { pin: i % 7 === 0 ? { as: "tile" } : null, page: i % 5 === 0 ? { kind: "asleep", wake: `restore:${i}` } : { kind: "idle" } }),
  }));
}

test("the session file is byte for byte what versionedJson wrote, for a migrated old file and a current one, before and after edits", () => {
  for (const [version, legacy] of [[2, true], [4, true], [SESSION_VERSION, false]]) {
    stub.docs.clear();
    stub.docs.set(SESSION_DOCUMENT, session(version, tabsAt(300, legacy)));
    S().hydrate(loadSession());
    assert.ok(JSON.parse(newJson()).tabs.length >= 250, `version ${version} loads its tabs`);
    sameAsBefore(`version ${version}, first save`);
    sameAsBefore(`version ${version}, served from the fragment cache`);
    useBrowser.setState((s) => ({ tabs: { ...s.tabs, t3: { ...s.tabs.t3, title: "Renamed \"page\"" }, t9: { ...s.tabs.t9, url: "https://moved.example/" } } }));
    sameAsBefore(`version ${version}, after a title and an address change`);
    assert.ok(newJson().includes('Renamed \\"page\\"') && newJson().includes("https://moved.example/"), "the changed tabs are written fresh");
    useBrowser.setState((s) => {
      const { t6: _gone, ...tabs } = s.tabs;
      return { tabs, groups: { ...s.groups, g1: { ...s.groups.g1, name: "Play" } }, splits: { v1: { id: "v1", windowId: "w1", orientation: "horizontal", slots: [{ size: 0.5, tabId: "t1" }, { size: 0.5, tabId: "t2" }] } } };
    });
    sameAsBefore(`version ${version}, after a close, a group rename and a split`);
  }
});

test("only a title, icon or last-used change is cosmetic; an address, pin, order or page change is not", () => {
  const t = { id: "a", windowId: "w", profileId: "default", url: "u", title: "A", favicon: null, pin: null, page: { kind: "idle" }, lastActiveAt: 1 };
  const u = { ...t, id: "b" };
  const before = { a: t, b: u };
  assert.equal(cosmeticTabsChange(before, { a: { ...t, title: "B", favicon: "data:x", lastActiveAt: 2, unseen: true }, b: u }), true);
  assert.equal(cosmeticTabsChange(before, { a: { ...t, page: { kind: "loaded", nav: { url: "u", seq: 3 } } }, b: u }), true, "a page that saves the same is cosmetic");
  assert.equal(cosmeticTabsChange(before, { a: { ...t, url: "v" }, b: u }), false);
  assert.equal(cosmeticTabsChange(before, { a: { ...t, pin: { as: "row" } }, b: u }), false);
  assert.equal(cosmeticTabsChange(before, { a: { ...t, page: { kind: "asleep" } }, b: u }), false);
  assert.equal(cosmeticTabsChange(before, { b: u, a: t }), false, "a reorder");
  assert.equal(cosmeticTabsChange(before, { a: t }), false, "a close");
});

test("title changes wait 10 s or the next flush; a structural change still saves within 800 ms", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    stub.docs.clear();
    stub.docs.set(SESSION_DOCUMENT, session(SESSION_VERSION, tabsAt(20, false)));
    const stop = startPersistence();
    const saved = () => JSON.parse(stub.docs.get(SESSION_DOCUMENT)).tabs.find((t) => t.id === "t3");
    useBrowser.setState((s) => ({ tabs: { ...s.tabs, t3: { ...s.tabs.t3, title: "Cosmetic" } } }));
    mock.timers.tick(5_000);
    assert.notEqual(saved().title, "Cosmetic", "not yet at 5 s");
    mock.timers.tick(5_000);
    assert.equal(saved().title, "Cosmetic", "saved at 10 s");
    useBrowser.setState((s) => ({ tabs: { ...s.tabs, t3: { ...s.tabs.t3, title: "Again" } } }));
    mock.timers.tick(1_000);
    useBrowser.setState((s) => ({ tabs: { ...s.tabs, t4: { ...s.tabs.t4, url: "https://structural.example/" } } }));
    mock.timers.tick(800);
    assert.equal(saved().title, "Again", "a structural change takes the pending title with it");
    assert.equal(JSON.parse(stub.docs.get(SESSION_DOCUMENT)).tabs.find((t) => t.id === "t4").url, "https://structural.example/");
    useBrowser.setState((s) => ({ tabs: { ...s.tabs, t3: { ...s.tabs.t3, title: "At quit" } } }));
    flushPersistence();
    assert.equal(saved().title, "At quit", "a flush writes it at once");
    stop();
  } finally {
    mock.timers.reset();
  }
});
