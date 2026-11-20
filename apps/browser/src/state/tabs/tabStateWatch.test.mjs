import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { tabStateChanges, watchTabState } = await import("./tabStateWatch.ts");
const { rowFlags } = await import("../sidebar/rowState.ts");
const { activeTabId } = await import("../browser/model.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

function session(plain) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const ids = [S().windows[w].tabIds[0]];
  for (let i = 0; i < plain; i++) ids.push(S().newTab(w, { url: `https://site${i % 7}.com/p/${i}`, background: true }));
  return { w, ids };
}

function watching(w) {
  const woken = new Set();
  const offs = new Map();
  const sync = () => {
    for (const id of Object.keys(S().tabs)) if (!offs.has(id)) offs.set(id, watchTabState(id, () => woken.add(id)));
  };
  sync();
  const values = () => Object.fromEntries(Object.keys(S().tabs).map((id) => [id, `${rowFlags(S(), w, id)}:${activeTabId(S(), w) === id}`]));
  return {
    run(what, act) {
      sync();
      const before = values();
      woken.clear();
      act();
      const after = values();
      for (const id of Object.keys(before)) {
        if (before[id] !== after[id]) assert.ok(woken.has(id), `${what}: tab ${id} changed (${before[id]} → ${after[id]}) without waking`);
      }
      return new Set(woken);
    },
    stop: () => offs.forEach((off) => off()),
  };
}

test("every action wakes each tab whose row state it changed", () => {
  const { w, ids } = session(14);
  const watch = watching(w);
  const [a, b, c, d, e, f, g] = ids;
  watch.run("switch", () => S().activate(b));
  watch.run("select", () => S().setSelection(w, [c, d]));
  watch.run("clear selection", () => S().setSelection(w, []));
  watch.run("loading", () => S().updateLive(c, { isLoading: true }));
  watch.run("audio", () => S().updateLive(d, { playingAudio: true }));
  watch.run("mute tab", () => S().updateTab(d, { muted: true }));
  watch.run("mute site", () => S().setSiteMuted(e, true));
  watch.run("fade unloaded", () => S().updateSettings({ fadeUnloadedTabs: true }));
  watch.run("load", () => S().activate(f));
  watch.run("engine", () => S().updateTab(g, { engine: "webkit" }));
  watch.run("child of a WebKit tab", () => S().newTab(w, { url: "https://child.com/", openerId: g, background: true }));
  watch.run("pin", () => S().pinTabs([a], true));
  watch.run("pinned tab loads", () => S().activate(a));
  watch.run("group", () => S().createGroup([e, f]));
  const pinnedGroup = S().createGroup([b, c]);
  watch.run("pin a group", () => S().updateGroup(pinnedGroup, { pinned: true }));
  watch.run("collapse a group", () => S().updateGroup(pinnedGroup, { collapsed: true }));
  watch.run("unpin a group", () => S().updateGroup(pinnedGroup, { pinned: false }));
  watch.run("split", () => S().createSplit([b, c]));
  watch.run("share tabs", () => S().updateSettings({ shareTabsAcrossWindows: true }));
  watch.run("second window", () => S().createWindow({ url: "https://z.com/" }));
  watch.run("close", () => S().closeTab(d));
  watch.run("close active", () => S().closeTab(S().windows[w].activeTabIds[S().windows[w].profileId]));
  watch.stop();
});

test("closing the tab a pending duplicate copies its engine from wakes the duplicate", () => {
  const { w, ids } = session(3);
  const [source, copy, other] = ids;
  S().updateSettings({ websiteEngines: { "https://a.com": "webkit" } });
  const adopted = (adopt) => ({ url: "https://a.com/", engine: undefined, page: { kind: "adopted", adopt, nav: null } });
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [source]: { ...s.tabs[source], ...adopted("ardiacore:123") }, [copy]: { ...s.tabs[copy], ...adopted(`clone:${source}`) } } }));
  S().activate(other);
  const watch = watching(w);
  const woken = watch.run("close the source", () => S().closeTab(source));
  assert.ok(woken.has(copy));
  watch.stop();
});

test("a switch and a new tab wake the tabs they touch, not every tab", () => {
  for (const count of [10, 120]) {
    const { w, ids } = session(count);
    const watch = watching(w);
    const switched = watch.run("switch", () => S().activate(ids[count - 3]));
    assert.ok(switched.size <= 2, `a switch woke ${switched.size} of ${count + 1} tabs`);
    const back = watch.run("switch back", () => S().activate(ids[2]));
    assert.ok(back.size <= 2, `a switch woke ${back.size} of ${count + 1} tabs`);
    const opened = watch.run("new tab", () => S().newTab(w));
    assert.ok(opened.size <= 3, `a new tab woke ${opened.size} of ${count + 2} tabs`);
    watch.stop();
  }
});

function sharedSession() {
  const { w, ids } = session(12);
  const [a, b, c, d, e] = ids;
  S().pinTabs([a], true);
  S().activate(a);
  const group = S().createGroup([b, c]);
  S().updateGroup(group, { pinned: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const w2 = S().createWindow({ url: "https://second.com/" });
  S().activate(d);
  return { w, w2, ids, pinned: a, grouped: b, listed: e };
}

test("a title, favicon or zoom change on a pinned, pinned-group or shared tab wakes only that tab", () => {
  const { w, pinned, grouped, listed } = sharedSession();
  const watch = watching(w);
  for (const [name, id] of [["pinned", pinned], ["pinned group", grouped], ["shared list", listed]]) {
    for (const [field, value] of [["title", "Inbox (3)"], ["favicon", "https://x.com/f.png"], ["zoom", 1.25]]) {
      const before = S().tabs;
      const woken = watch.run(`${field} on the ${name} tab`, () => S().updateTab(id, { [field]: value }));
      const rewritten = Object.keys(S().tabs).filter((x) => S().tabs[x] !== before[x]);
      const others = [...woken].filter((x) => !rewritten.includes(x));
      assert.deepEqual(others, [], `a ${field} change on the ${name} tab woke ${others.length} rows it didn't change`);
      assert.ok(woken.size <= 2, `a ${field} change on the ${name} tab woke ${woken.size} tabs`);
    }
  }
  watch.stop();
});

test("changes to a shared tab that other rows read still wake those rows", () => {
  const { w, w2, ids, pinned, grouped, listed } = sharedSession();
  const watch = watching(w);
  const copies = () => Object.values(S().tabs).filter((t) => t.windowId === w2 && t.pin).map((t) => t.id);
  watch.run("the pinned tab's page sleeps", () => S().updateTab(pinned, { page: { kind: "asleep" } }));
  watch.run("the pinned tab loads again", () => S().activate(pinned));
  assert.ok(copies().length > 0, "the second window mirrors the pinned tab");
  for (const copy of copies()) watch.run("a mirrored copy is shown", () => S().activate(copy));
  watch.run("the holder closes", () => S().closeTab(pinned));
  watch.run("a pin key changes", () => S().updateTab(grouped, { pinKey: "elsewhere" }));
  watch.run("a pin key comes back", () => S().updateTab(grouped, { pinKey: undefined }));
  watch.run("a shared tab moves window", () => S().moveTabsToWindow([listed], w2));
  watch.run("a shared tab changes profile", () => S().updateTab(ids[6], { profileId: "other" }));
  watch.run("a shared tab loses its url", () => S().updateTab(ids[7], { url: "" }));
  watch.run("a shared tab becomes a live item", () => S().updateTab(ids[8], { liveItem: { folderId: "f", itemId: "i" } }));
  watch.run("a pinned tab becomes a top app", () => S().pinTabs([ids[9]], true));
  watch.run("unpin", () => S().pinTabs([ids[9]], false));
  watch.stop();
});

function holderAndCopy({ shareTopApps = false, listed = false } = {}) {
  S().hydrate({});
  const w1 = S().createWindow({ url: "https://one.com/" });
  const w2 = S().createWindow({ url: "https://two.com/" });
  const p1 = S().windows[w1].profileId;
  const p2 = shareTopApps ? "second" : p1;
  const now = Date.now();
  const base = { url: "https://mail.com/", title: "Mail", favicon: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, createdAt: now, lastActiveAt: now, pinKey: "mail" };
  const pin = listed ? null : shareTopApps ? { as: "tile" } : { as: "row" };
  const holder = { ...base, id: "holder", windowId: w1, profileId: p1, pin, page: { kind: "loaded", nav: { url: base.url, seq: 1 } } };
  const copy = { ...base, id: "copy", windowId: w2, profileId: p2, pin, page: { kind: "idle" } };
  useBrowser.setState((s) => ({
    tabs: { ...s.tabs, holder, copy },
    windows: {
      ...s.windows,
      [w1]: { ...s.windows[w1], tabIds: [...s.windows[w1].tabIds, "holder"] },
      [w2]: { ...s.windows[w2], profileId: p2, tabIds: [...s.windows[w2].tabIds, "copy"] },
    },
    profiles: shareTopApps ? { ...s.profiles, [p1]: { ...s.profiles[p1], shareTopApps: true, dataId: "shared" }, second: { ...s.profiles[p1], id: "second", name: "Second", shareTopApps: true, dataId: "shared" } } : s.profiles,
    profileOrder: shareTopApps ? [...s.profileOrder, "second"] : s.profileOrder,
    settings: { ...s.settings, fadeUnloadedTabs: true, closedTopAppTiles: true, shareTabsAcrossWindows: listed },
  }));
  return { w1, w2 };
}

const holderChanges = [
  ["sleeps", () => ({ page: { kind: "asleep" } })],
  ["gets another pin key", () => ({ pinKey: "other" })],
  ["moves to the copy's window", (w) => ({ windowId: w.w2 })],
  ["changes profile", () => ({ profileId: "elsewhere" })],
  ["is unpinned", () => ({ pin: null })],
  ["becomes a row", () => ({ pin: { as: "row" } })],
  ["loses its url", () => ({ url: "" })],
  ["becomes a live item", () => ({ liveItem: { folderId: "f", itemId: "i" } })],
];

function wokenBy(next, prev) {
  const woken = new Set();
  const all = tabStateChanges(next, prev, (id) => woken.add(id)) === true;
  return (id) => all || woken.has(id);
}

test("every holder change that alters another row's flags wakes that row, checked on raw states with no settle in between", () => {
  const proved = new Set();
  for (const setup of [{}, { shareTopApps: true }, { listed: true }]) {
    for (const [what, change] of holderChanges) {
      const w = holderAndCopy(setup);
      const settled = S();
      const prev = { ...settled, tabs: { ...settled.tabs, copy: { ...settled.tabs.copy, page: { kind: "idle" } } } };
      const next = { ...prev, tabs: { ...prev.tabs, holder: { ...prev.tabs.holder, ...change(w) } } };
      const before = rowFlags(prev, w.w2, "copy");
      const after = rowFlags(next, w.w2, "copy");
      if (before === after) continue;
      proved.add(what);
      assert.ok(wokenBy(next, prev)("copy"), `${JSON.stringify(setup)} the holder ${what}: the copy's flags went ${before} → ${after} without waking it`);
    }
  }
  assert.deepEqual([...proved].sort(), holderChanges.map(([what]) => what).sort(), "each change is shown to alter a copy's flags in at least one setup");
});

test("a title, favicon, zoom, mute or activity change on a holder leaves the copy asleep, checked on raw states", () => {
  for (const setup of [{}, { shareTopApps: true }, { listed: true }]) {
    holderAndCopy(setup);
    const settled = S();
    const prev = { ...settled, tabs: { ...settled.tabs, copy: { ...settled.tabs.copy, page: { kind: "idle" } } } };
    for (const change of [{ title: "Mail (3)" }, { favicon: "https://mail.com/f.png" }, { zoom: 1.5 }, { muted: true }, { lastActiveAt: prev.tabs.holder.lastActiveAt + 1 }]) {
      const next = { ...prev, tabs: { ...prev.tabs, holder: { ...prev.tabs.holder, ...change } } };
      assert.equal(wokenBy(next, prev)("copy"), false, `${JSON.stringify(setup)} ${Object.keys(change)[0]} woke the copy`);
    }
  }
});
