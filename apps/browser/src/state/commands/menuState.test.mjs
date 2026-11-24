import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { liveReachesMenu, menuInputsChanged, menuLiveKey, menuState, pagesChangeMenu, trackedMenuState, HIDDEN_TAB_FIELDS_IN_MENU } = await import("./menuState.ts");
const { patchPage, usePages } = await import("../tabs/pageState.ts");
const { noRecordReads, trackedRecord } = await import("../browser/recordReads.ts");
const { liveOf, onLiveChange, shownLiveOf } = await import("../tabs/tabLive.ts");
const { focusedWindowOf } = await import("../windows/ui.ts");

const S = () => useBrowser.getState();
const menuJson = (s) => JSON.stringify(menuState(s));

function inputsChangedBy(step, reads) {
  const before = S();
  const liveKey = menuLiveKey(before);
  const pagesBefore = usePages.getState().pages;
  const live = new Set();
  const off = onLiveChange((id) => live.add(id));
  step();
  off();
  const after = S();
  const liveChanged = [...live].some((id) => liveReachesMenu(after, id)) && menuLiveKey(after) !== liveKey;
  return menuInputsChanged(reads, after, before) || liveChanged || pagesChangeMenu(after, usePages.getState().pages, pagesBefore);
}

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
    const { state, reads } = trackedMenuState(S());
    if (inputsChangedBy(step, reads)) read++;
    else {
      unread++;
      assert.equal(menuJson(S()), JSON.stringify(state), `${step} changed the menu without touching a field it read`);
    }
  }
  assert.ok(unread >= 2, "some steps touch only fields the menu doesn't read");
  assert.ok(read >= 5, "steps that change the menu are caught");
});

test("the reads cover every top-level field the menu used, including through its helpers", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.example/" });
  const { reads } = trackedMenuState(S());
  const liveRead = [];
  menuState(S(), (id) => (liveRead.push(id), liveOf(id)));
  assert.deepEqual(liveRead, [model.activeTabId(S(), focusedWindowOf(S()))]);
  for (const field of ["windows", "tabs", "settings", "closedTabs", "closedWindows", "closedGroups", "bookmarks", "profiles", "profileOrder", "downloads", "ui"]) {
    assert.ok(reads.keys.has(field), field);
  }
  assert.equal(reads.keys.has("history"), false);
});

function menuChanges(step) {
  const { state, reads } = trackedMenuState(S());
  const changed = inputsChangedBy(step, reads);
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
  const rand = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const pick = (list) => list[rand(list.length)];
  const steps = [
    (id) => S().updateTab(id, { title: `Title ${rand(5)}` }),
    (id) => S().updateTab(id, { favicon: `https://x.example/${rand(3)}.ico` }),
    (id) => S().updateTab(id, { muted: !S().tabs[id].muted }),
    (id) => S().updateTab(id, { url: pick(["https://a.example/", "file:///tmp/a.txt", "https://b.example/page"]) }),
    (id) => S().updateTab(id, { customTitle: pick([null, "Mine"]) }),
    (id) => S().updateTab(id, { pin: pick([null, { as: "row" }, { as: "tile" }]) }),
    (id) => S().updateTab(id, { pinnedUrl: pick([null, "https://a.example/"]) }),
    (id) => S().updateLive(id, { isLoading: !liveOf(id).isLoading }),
    (id) => S().updateLive(id, { canGoBack: !liveOf(id).canGoBack, canGoForward: !!rand(2) }),
    (id) => S().updateLive(id, { themeColor: pick([null, "#123456", "#abcdef"]), playingAudio: !!rand(2) }),
    (id) => {
      const opener = pick([null, ...Object.keys(S().tabs)]);
      S().updateTab(id, { openerId: opener, linkOpenerId: rand(2) ? opener : null });
    },
    (id) => patchPage(id, { status: pick(["", "Loading…", "https://x.example/"]), blocked: rand(3) }),
    (id) => patchPage(id, { backToNewTab: !!rand(2) }),
    (id) => patchPage(id, { newTabShown: rand(2) ? { url: "https://n.example/", title: "N", favicon: null } : null }),
    (id) => patchPage(id, { engineBack: rand(2) ? { engine: "webkit", url: "https://e.example/" } : null }),
    (id) => S().activate(id),
    (id) => S().setSelection(S().tabs[id].windowId, [id, pick(S().windows[S().tabs[id].windowId].tabIds)]),
    (id) => S().setFocusedWindow(S().tabs[id].windowId),
    (id) => S().newTab(S().tabs[id].windowId, { url: "https://new.example/", background: !!rand(2) }),
    (id) => Object.keys(S().tabs).length > 6 && S().closeTab(id),
  ];
  let kept = 0;
  const ran = new Set();
  for (let i = 0; i < 600; i++) {
    const index = rand(steps.length);
    ran.add(index);
    const step = steps[index];
    const id = pick(Object.keys(S().tabs));
    if (!menuChanges(() => step(id))) kept++;
  }
  assert.equal(ran.size, steps.length, `only ${ran.size} of ${steps.length} kinds of step ran`);
  assert.ok(kept > 100, `only ${kept} of 600 steps left the menu alone`);
});

test("what a load changes in the shown tab and the menu never shows leaves the menu alone", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  const shown = model.activeTabId(S(), w);
  assert.equal(menuChanges(() => S().updateTab(shown, { favicon: "https://a.example/favicon.ico" })), false);
  assert.equal(menuChanges(() => patchPage(shown, { status: "Loading…", blocked: 2 })), false);
  assert.equal(menuChanges(() => S().updateLive(shown, { themeColor: "#123456" })), false);
  assert.equal(menuChanges(() => S().updateTab(shown, { url: "file:///tmp/a.txt" })), true, "page commands follow the URL");
  assert.equal(menuChanges(() => S().updateLive(shown, { isLoading: true })), true, "Stop turns on");
  assert.equal(menuChanges(() => patchPage(shown, { backToNewTab: true })), true, "Back turns on to go back to the New Tab page");
  patchPage(shown, { backToNewTab: false });
  const opener = S().newTab(w, { url: "https://opener.example/", background: true });
  S().updateTab(shown, { openerId: opener, linkOpenerId: null });
  assert.equal(menuChanges(() => S().updateTab(shown, { linkOpenerId: opener })), true, "Back turns on to close the tab back to the page that opened it");
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
    const liveRead = new Set();
    menuState({ ...s, tabs: trackedRecord(s.tabs, tabs) }, (id) => (liveRead.add(id), shownLiveOf(s, id)));
    const shown = new Set([...Object.values(s.windows).flatMap((w) => Object.values(w.activeTabIds)), ...(s.selection[windows[0]] ?? [])]);
    assert.equal(tabs.enumerated, false, "the menu listed every tab: a hidden tab's change would have to rebuild it");
    for (const [id, fields] of tabs.entries) {
      if (shown.has(id)) continue;
      assert.notEqual(fields, null, `${id} was read whole`);
      for (const field of fields) assert.ok(HIDDEN_TAB_FIELDS_IN_MENU.includes(field), `the menu read a hidden tab's ${field}`);
    }
    for (const id of liveRead) assert.ok(shown.has(id), `the menu read a hidden tab's live state (${id})`);
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

test("the shown Peek's page rebuilds the menu like a shown tab; a Peek hidden behind another tab doesn't", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const source = model.activeTabId(S(), w);
  const other = S().newTab(w, { url: "https://b.example/", background: true });
  const shownPeek = S().openPeek(other, "https://peek.example/");
  S().activate(other);
  const hiddenPeek = S().openPeek(source, "https://hidden.example/");
  S().activate(other);
  S().setFocusedWindow(w);
  assert.equal(menuChanges(() => S().updateLive(shownPeek, { canGoForward: true })), true, "Forward turns on in the Peek");
  assert.equal(menuChanges(() => S().updateTab(shownPeek, { muted: true })), true, "Mute Tab becomes Unmute Tab");
  assert.equal(menuChanges(() => S().updateTab(hiddenPeek, { muted: true })), false);
});

test("the menu state tells the shell whether links from other apps open in Little Ardia", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.example/" });
  S().updateSettings({ openLinksInLittleArdia: true });
  assert.equal(menuState(S()).linksOpenInLittleArdia, true);
  S().updateSettings({ openLinksInLittleArdia: false });
  assert.equal(menuState(S()).linksOpenInLittleArdia, false);
});

test("reader writes the menu can't show don't re-sync it, and ones it shows do", async () => {
  const { readerChangesMenu } = await import("./menuState.ts");
  const none = { url: "", available: false, active: false };
  const checked = { url: "https://a.example/", available: false, active: false };
  assert.equal(readerChangesMenu({ t1: checked }, {}), false);
  assert.equal(readerChangesMenu({ t1: { ...checked, url: "https://b.example/" } }, { t1: checked }), false);
  assert.equal(readerChangesMenu({ t1: none }, { t1: undefined }), false);
  assert.equal(readerChangesMenu({ t1: { ...checked, available: true } }, { t1: checked }), true);
  assert.equal(readerChangesMenu({ t1: { ...checked, active: true } }, { t1: { ...checked, available: true } }), true);
  assert.equal(readerChangesMenu({}, { t1: { ...checked, active: true } }), true);
  assert.equal(readerChangesMenu({}, { t1: checked }), false);
});

test("an extension list fetched again with what the menu shows unchanged doesn't re-sync it", async () => {
  const { extensionsChangeMenu } = await import("./menuState.ts");
  const ext = { id: "abc", name: "Blocker", icon: "icon.png", actionIcon: null, enabled: true, incognito: false, pinned: true, pinnedIndex: 0 };
  const before = { p1: [ext] };
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext }] }, before), false);
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext, pinnedIndex: 3 }] }, before), false);
  assert.equal(extensionsChangeMenu({ ...before, p2: [] }, before), false);
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext, name: "Blocker Pro" }] }, before), true);
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext, actionIcon: "badge.png" }] }, before), true);
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext, enabled: false }] }, before), true);
  assert.equal(extensionsChangeMenu({ p1: [{ ...ext, incognito: true }] }, before), true);
  assert.equal(extensionsChangeMenu({ p1: [ext, { ...ext, id: "def" }] }, before), true);
  assert.equal(extensionsChangeMenu({}, before), true);
});

test("private windows disable Bookmarks Bar commands in menuState and ignore them in runCommand", async () => {
  const { runCommand } = await import("./commands.ts");
  S().hydrate({});
  S().updateSettings({ bookmarksBar: "never" });
  const priv = S().createWindow({ kind: "private", url: "https://private.example/" });
  S().setFocusedWindow(priv);
  const state = menuState(S());
  assert.ok(state.disabled.includes("setBookmarksBar"));
  assert.ok(state.disabled.includes("toggleBookmarksBar"));
  runCommand({ command: "setBookmarksBar", arg: "always", windowId: priv });
  assert.equal(S().settings.bookmarksBar, "never");
  runCommand({ command: "toggleBookmarksBar", arg: null, windowId: priv });
  assert.equal(S().settings.bookmarksBar, "never");
});

test("Browser Layout menu bar commands switch tab placement in one pick, gate Compact Toolbar, and expose Collapse/Expand Pinned Tabs", async () => {
  const { runCommand } = await import("./commands.ts");
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const tabId = model.activeTabId(S(), w);
  S().setFocusedWindow(w);
  assert.ok(menuState(S()).checked.includes("setTabLayout:sidebarLeft"));
  assert.ok(menuState(S()).disabled.includes("togglePinnedFold"));
  assert.ok(!menuState(S()).disabled.includes("toggleCompactToolbar"));
  runCommand({ command: "setTabLayout", arg: "top", windowId: w });
  assert.equal(model.tabLayoutOf(S(), w), "top");
  assert.ok(menuState(S()).checked.includes("setTabLayout:top"));
  runCommand({ command: "setTabLayout", arg: "sidebarRight", windowId: w });
  assert.equal(model.tabLayoutOf(S(), w), "sidebar");
  assert.equal(S().settings.sidebarSide, "right");
  assert.ok(menuState(S()).checked.includes("setTabLayout:sidebarRight"));
  S().updateSettings({ addressBar: "sidebar" });
  assert.ok(menuState(S()).disabled.includes("toggleCompactToolbar"));
  runCommand({ command: "toggleCompactToolbar", arg: null, windowId: w });
  assert.equal(S().settings.compactToolbar, false);
  S().updateSettings({ addressBar: "toolbar" });
  runCommand({ command: "toggleCompactToolbar", arg: null, windowId: w });
  assert.equal(S().settings.compactToolbar, true);
  assert.ok(menuState(S()).checked.includes("toggleCompactToolbar"));
  S().pinTabs([tabId], true, true);
  assert.ok(!menuState(S()).disabled.includes("togglePinnedFold"));
  runCommand({ command: "togglePinnedFold", arg: null, windowId: w });
  assert.equal(menuState(S()).titles.togglePinnedFold, "Expand Pinned Tabs");
  runCommand({ command: "togglePinnedFold", arg: null, windowId: w });
  assert.equal(menuState(S()).titles.togglePinnedFold, undefined);
});

test("Little Ardia direct command dispatch ignores Browser Layout commands", async () => {
  const { runCommand } = await import("./commands.ts");
  S().hydrate({});
  const main = S().createWindow({ url: "https://a.example/" });
  const tabId = model.activeTabId(S(), main);
  S().pinTabs([tabId], true, true);
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  S().setFocusedWindow(small);
  runCommand({ command: "setTabLayout", arg: "top", windowId: small });
  runCommand({ command: "setTabLayout", arg: "sidebarRight", windowId: small });
  runCommand({ command: "toggleCompactToolbar", arg: null, windowId: small });
  runCommand({ command: "toggleFullUrl", arg: null, windowId: small });
  runCommand({ command: "togglePinnedFold", arg: null, windowId: small });
  runCommand({ command: "toggleMinimalism", arg: null, windowId: small });
  assert.ok(menuState(S()).disabled.includes("toggleFullUrl"));
  assert.equal(model.tabLayoutOf(S(), main), "sidebar");
  assert.equal(S().settings.sidebarSide, "left");
  assert.equal(S().settings.compactToolbar, false);
  assert.equal(S().settings.showFullUrl, false);
  assert.equal(S().settings.minimalismMode, false);
  assert.equal(!!S().profiles.default.pinnedCollapsed, false);
});

test("Collapse Pinned Tabs stays disabled when a pinned group holds only a hidden empty tab", async () => {
  const { pinnedFoldMenuItem } = await import("../sidebar/pinnedFold.ts");
  S().hydrate({});
  S().updateSettings({ newTabOpens: "commandBar" });
  const w = S().createWindow({ url: "https://a.example/" });
  const blank = S().newTab(w, { url: "", background: true });
  S().groupTabs([blank], { name: "Empty", pinned: true });
  S().setFocusedWindow(w);
  assert.deepEqual(pinnedFoldMenuItem(S(), w), []);
  assert.ok(menuState(S()).disabled.includes("togglePinnedFold"));
  S().updateTab(blank, { url: "https://real.example/" });
  assert.equal(pinnedFoldMenuItem(S(), w).length, 1);
  assert.ok(!menuState(S()).disabled.includes("togglePinnedFold"));
});
