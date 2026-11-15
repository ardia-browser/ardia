import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { menuInputsChanged, menuState, trackedMenuState, HIDDEN_TAB_FIELDS_IN_MENU } = await import("./menuState.ts");
const { noRecordReads, trackedRecord } = await import("../browser/recordReads.ts");

const S = () => useBrowser.getState();
const menuJson = (s) => JSON.stringify(menuState(s));

test("a store change the last menu build didn't read leaves the menu as it was, and one it read is caught", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const first = model.activeTabId(S(), w);
  const steps = [
    () => S().updateLive(first, { isLoading: true, progress: 0.3 }),
    () => S().updateLive(first, { progress: 0.6 }),
    () => S().updateTab(first, { title: "A page" }),
    () => S().newTab(w, { url: "https://b.example/" }),
    () => S().updateLive(first, { isLoading: false, canGoBack: true }),
    () => useBrowser.setState({ find: { ...S().find } }),
    () => useBrowser.setState({ history: { ...S().history } }),
    () => S().updateSettings({ warnBeforeQuitting: !S().settings.warnBeforeQuitting }),
    () => S().addBookmark({ profileId: "default", url: "https://b.example/", title: "B" }),
    () => S().createWindow({ url: "https://c.example/" }),
    () => S().closeTab(first),
  ];
  let unread = 0;
  let read = 0;
  for (const step of steps) {
    const before = S();
    const { state, reads } = trackedMenuState(before);
    step();
    const after = S();
    if (menuInputsChanged(reads, after, before)) read++;
    else {
      unread++;
      assert.equal(menuJson(after), JSON.stringify(state), `${step} changed the menu without touching a field it read`);
    }
  }
  assert.ok(unread >= 2, "some steps touch only fields the menu doesn't read");
  assert.ok(read >= 5, "steps that change the menu are caught");
});

test("the reads cover every top-level field the menu used, including through its helpers", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.example/" });
  const { reads } = trackedMenuState(S());
  for (const field of ["windows", "tabs", "live", "settings", "closedTabs", "closedWindows", "closedGroups", "bookmarks", "profiles", "profileOrder", "downloads", "ui"]) {
    assert.ok(reads.has(field), field);
  }
  assert.equal(reads.has("history"), false);
});

function menuChanges(step) {
  const before = S();
  const { state, reads } = trackedMenuState(before);
  step();
  const changed = menuInputsChanged(reads, S(), before);
  if (!changed) assert.equal(menuJson(S()), JSON.stringify(state), `${step} changed the menu without touching anything it read`);
  return changed;
}

test("a hidden tab's title, icon, mute or loading leaves the menu alone; what the menu shows of a tab still rebuilds it", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const shown = model.activeTabId(S(), w);
  const hidden = S().newTab(w, { url: "https://b.example/", background: true });
  const other = S().createWindow({ url: "file:///tmp/notes.txt" });
  const otherShown = model.activeTabId(S(), other);
  const otherHidden = S().newTab(other, { url: "file:///tmp/todo.txt", background: true });
  S().setFocusedWindow(w);
  assert.equal(model.activeTabId(S(), w), shown);
  assert.equal(menuChanges(() => S().updateTab(hidden, { title: "(3) Inbox" })), false);
  assert.equal(menuChanges(() => S().updateTab(hidden, { favicon: "https://b.example/unread.ico" })), false);
  assert.equal(menuChanges(() => S().updateTab(hidden, { muted: true })), false);
  assert.equal(menuChanges(() => S().updateLive(hidden, { isLoading: true, canGoBack: true })), false);
  assert.equal(menuChanges(() => S().updateTab(otherHidden, { title: "Todo" })), false);
  assert.equal(menuChanges(() => S().updateTab(shown, { muted: true })), true, "Mute Tab becomes Unmute Tab");
  assert.equal(menuChanges(() => S().updateLive(shown, { canGoBack: true })), true, "Back turns on");
  assert.equal(menuChanges(() => S().updateTab(otherShown, { title: "Notes" })), true, "the Window menu names the other window by its shown tab");
  menuChanges(() => S().updateTab(hidden, { pin: { as: "row" } }));
  assert.equal(menuChanges(() => S().closeTab(otherHidden)), true, "the other window's title counts its tabs");
  assert.equal(menuChanges(() => S().activate(hidden)), true);
  assert.equal(menuChanges(() => S().updateTab(hidden, { muted: false })), true, "the tab is shown now");
  assert.equal(menuChanges(() => S().updateTab(shown, { muted: false })), false, "and the one it replaced is hidden");
});

test("whatever changes in tabs and their live state, a menu that isn't rebuilt is the menu a rebuild would give", () => {
  S().hydrate({});
  const windows = [S().createWindow({ url: "https://a.example/" }), S().createWindow({ url: "https://b.example/" })];
  for (const w of windows) for (let i = 0; i < 4; i++) S().newTab(w, { url: `https://${i}.example/`, background: true });
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const pick = (list) => list[rand(list.length)];
  const steps = [
    (id) => S().updateTab(id, { title: `Title ${rand(5)}` }),
    (id) => S().updateTab(id, { favicon: `https://x.example/${rand(3)}.ico` }),
    (id) => S().updateTab(id, { muted: !S().tabs[id].muted }),
    (id) => S().updateTab(id, { url: pick(["https://a.example/", "file:///tmp/a.txt", "https://b.example/page"]) }),
    (id) => S().updateTab(id, { customTitle: pick([null, "Mine"]) }),
    (id) => S().updateTab(id, { pin: pick([null, { as: "row" }, { as: "tile" }]) }),
    (id) => S().updateTab(id, { pinnedUrl: pick([null, "https://a.example/"]) }),
    (id) => S().updateLive(id, { isLoading: !S().live[id]?.isLoading }),
    (id) => S().updateLive(id, { canGoBack: !S().live[id]?.canGoBack, canGoForward: !!rand(2) }),
    (id) => S().activate(id),
    (id) => S().setSelection(S().tabs[id].windowId, [id, pick(S().windows[S().tabs[id].windowId].tabIds)]),
    (id) => S().setFocusedWindow(S().tabs[id].windowId),
    (id) => S().newTab(S().tabs[id].windowId, { url: "https://new.example/", background: !!rand(2) }),
    (id) => Object.keys(S().tabs).length > 6 && S().closeTab(id),
  ];
  let kept = 0;
  for (let i = 0; i < 600; i++) {
    const step = pick(steps);
    const id = pick(Object.keys(S().tabs));
    if (!menuChanges(() => step(id))) kept++;
  }
  assert.ok(kept > 100, `only ${kept} of 600 steps left the menu alone`);
});

test("of a tab that isn't shown or selected, the menu reads only the fields a change is checked against, and none of its live state", () => {
  S().hydrate({});
  const windows = [S().createWindow({ url: "https://a.example/" }), S().createWindow({ url: "file:///tmp/notes.txt" })];
  for (const w of windows) for (let i = 0; i < 4; i++) S().newTab(w, { url: `https://${i}.example/`, background: true });
  const ids = S().windows[windows[0]].tabIds;
  S().updateTab(ids[1], { pin: { as: "row" }, pinnedUrl: "https://elsewhere.example/" });
  S().updateTab(ids[2], { pin: { as: "tile" }, muted: true });
  S().updateLive(ids[3], { isLoading: true, canGoBack: true });
  for (const [focused, selection] of [[windows[0], []], [windows[1], []], [windows[0], [ids[0], ids[3]]]]) {
    S().setFocusedWindow(focused);
    S().setSelection(windows[0], selection);
    const s = S();
    const tabs = noRecordReads();
    const live = noRecordReads();
    menuState({ ...s, tabs: trackedRecord(s.tabs, tabs), live: trackedRecord(s.live, live) });
    const shown = new Set([...Object.values(s.windows).flatMap((w) => Object.values(w.activeTabIds)), ...(s.selection[windows[0]] ?? [])]);
    assert.equal(tabs.enumerated, false, "the menu listed every tab: a hidden tab's change would have to rebuild it");
    for (const [id, fields] of tabs.entries) {
      if (shown.has(id)) continue;
      assert.notEqual(fields, null, `${id} was read whole`);
      for (const field of fields) assert.ok(HIDDEN_TAB_FIELDS_IN_MENU.includes(field), `the menu read a hidden tab's ${field}`);
    }
    for (const id of live.entries.keys()) assert.ok(shown.has(id), `the menu read a hidden tab's live state (${id})`);
  }
});

test("History › Recently Closed lists only what the window's shown profile closed", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.example/" });
  const personal = S().newTab(w, { url: "https://personal.example/" });
  S().updateTab(personal, { title: "Personal page" });
  const grouped = S().newTab(w, { url: "https://grouped.example/" });
  S().closeGroup(S().createGroup([grouped], { name: "Personal group" }));
  S().closeTab(personal);
  const other = S().createWindow({ url: "https://other.example/" });
  S().updateTab(model.activeTabId(S(), other), { title: "Personal window" });
  S().closeWindow(other);
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const job = S().newTab(w, { url: "https://work.example/" });
  S().updateTab(job, { title: "Work page" });
  S().closeTab(job);
  const titles = () => [...menuState(S()).recentlyClosed, ...menuState(S()).recentlyClosedGroups].map((e) => e.title);
  assert.deepEqual(titles(), ["Work page"]);
  S().switchProfile(w, "default");
  assert.ok(titles().includes("Personal page"), titles().join(", "));
  assert.ok(titles().includes("Personal group (1 Tab)"), titles().join(", "));
  assert.ok(titles().some((t) => t.startsWith("Window")), titles().join(", "));
  assert.ok(!titles().includes("Work page"));
  S().switchProfile(w, work);
  const workWindow = S().createWindow({ profileId: work, url: "https://work-window.example/" });
  S().switchProfile(workWindow, "default");
  S().newTab(workWindow, { url: "https://kept.example/" });
  S().switchProfile(workWindow, work);
  S().closeWindow(workWindow);
  S().switchProfile(w, "default");
  const before = titles().filter((t) => t.startsWith("Window")).length;
  S().deleteProfile(work);
  assert.equal(titles().filter((t) => t.startsWith("Window")).length, before + 1, "a closed window whose profile was deleted reopens in the default profile, so it lists there");
});
