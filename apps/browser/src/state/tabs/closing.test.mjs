import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { closeIntent, closeKind } = await import("./tabs.ts");
const { activeTabId, viewTabIds } = await import("../browser/model.ts");
const { closeTab } = await import("../browser/actions.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");
const { closeWindowDialog } = await import("../windows/windowClose.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("closing a Peek through either call ends the Peek and records nothing", () => {
  for (const close of [(id) => S().closeTab(id), (id) => S().closeTabs([id])]) {
    const { w, ids: [a] } = windowWith("a", "b");
    const peek = S().openPeek(a, "https://peek.example/", { x: 0, y: 0 });
    const closed = S().closedTabs.length;
    close(peek);
    assert.equal(S().peeks[a], undefined);
    assert.equal(S().tabs[peek], undefined);
    assert.ok(S().tabs[a]);
    assert.equal(S().closedTabs.length, closed);
  }
});

test("⌘W on the last tab closes the window; closing every tab at once keeps it with a New Tab", () => {
  const one = windowWith("a");
  S().closeTab(one.ids[0]);
  assert.equal(S().windows[one.w], undefined);

  const all = windowWith("a", "b");
  S().closeTabs(all.ids);
  assert.ok(S().windows[all.w]);
  const left = viewTabIds(S(), all.w);
  assert.equal(left.length, 1);
  assert.equal(S().tabs[left[0]].url, "");
});

test("closing a pinned tab with regular tabs unloads it and closes only those", () => {
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  S().pinTabs([a], true, true);
  S().activate(a);
  S().closeTabs([a, b]);
  assert.ok(S().tabs[a], "the pinned row stays");
  assert.equal(!!S().tabs[a].page.nav || !!S().tabs[a].page.adopt, false, "unloaded");
  assert.equal(S().tabs[b], undefined);
  assert.ok(S().windows[w]);
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], c);
});

test("what ✕ does: close a tab, unload an open pin, remove a closed pinned row", () => {
  const { ids: [a, b, c] } = windowWith("a", "b", "c");
  S().pinTabs([a], true);
  S().pinTabs([b], true, true);
  S().activate(c);
  assert.deepEqual(closeIntent(S(), c), { kind: "close", ids: [c] });
  assert.equal(closeKind(S(), b), "unload");
  S().closeTabs([a, b]);
  assert.equal(closeKind(S(), b), "removePin");
  assert.deepEqual(closeIntent(S(), a), { kind: "unload", ids: [a] }, "a closed tile only unloads");
});

function lastTabBesidePinned(pin) {
  const { w, ids: [kept, last] } = windowWith("pinned", "last");
  pin(kept);
  S().activate(last);
  S().closeTabs([kept]);
  assert.equal(S().tabs[kept].page.kind, "asleep");
  return { w, kept, last };
}

const pinnings = {
  tile: (id) => S().pinTabs([id], true),
  "pinned row": (id) => S().pinTabs([id], true, true),
  "pinned group": (id) => S().groupTabs([id], { pinned: true }),
};

for (const [kind, pin] of Object.entries(pinnings)) {
  test(`closing the last tab beside an asleep ${kind} keeps the window, asks nothing and selects a New Tab, not the ${kind}`, async () => {
    const { w, kept, last } = lastTabBesidePinned(pin);
    await closeTab(last);
    assert.ok(S().windows[w], "the window stays");
    assert.equal(S().tabs[last], undefined, "the tab closed without a confirmation, which the test shell declines");
    const shown = activeTabId(S(), w);
    assert.notEqual(shown, kept);
    assert.equal(S().tabs[shown].url, "");
    assert.equal(S().tabs[kept].page.kind, "asleep", "the pinned item stays asleep");
    assert.deepEqual(viewTabIds(S(), w).sort(), [kept, shown].sort());
  });
}

test("⌘W on the empty window left beside pinned items closes the window as before", () => {
  const { w, last } = lastTabBesidePinned(pinnings.tile);
  S().closeTab(last);
  const empty = activeTabId(S(), w);
  S().closeTab(empty);
  assert.equal(S().windows[w], undefined);
});

test("⌘W on the empty window left beside pinned items closes it without asking", async () => {
  const { w, last } = lastTabBesidePinned(pinnings.tile);
  S().closeTab(last);
  await closeTab(activeTabId(S(), w));
  assert.equal(S().windows[w], undefined, "the test shell declines every confirmation, so only an unasked close gets through");
});

test("⌘W on a window whose only tab is empty closes it without asking", async () => {
  S().hydrate({});
  const w = S().createWindow();
  const [empty] = S().windows[w].tabIds;
  assert.equal(S().tabs[empty].url, "");
  await closeTab(empty);
  assert.equal(S().windows[w], undefined);
});

test("the close dialog counts the tabs with something open and leaves the empty one out", () => {
  const { w } = windowWith("a", "b");
  S().newTab(w);
  assert.equal(closeWindowDialog(w).title, "Close 2 tabs?");
});

test("an empty pinned group alone keeps the window on its last tab's close", () => {
  const { w, ids: [only] } = windowWith("only");
  const group = { id: "pinned-empty", windowId: w, profileId: S().windows[w].profileId, name: "Empty", icon: null, color: null, collapsed: false, pinned: true, tabIds: [], createdAt: 0 };
  useBrowser.setState({ groups: { ...S().groups, [group.id]: group } });
  S().closeTab(only);
  assert.ok(S().windows[w]);
  assert.equal(S().tabs[activeTabId(S(), w)].url, "");
});

test("without pinned items the last tab still asks before closing its window", async () => {
  const { w, ids: [only] } = windowWith("only");
  await closeTab(only);
  assert.ok(S().tabs[only], "the declined confirmation keeps the tab");
  S().closeTab(only);
  assert.equal(S().windows[w], undefined);
});

test("a pinned item in the profile the window doesn't show keeps nothing open", () => {
  const { w, ids: [only] } = windowWith("only");
  const other = S().createProfile({ name: "Other" });
  const elsewhere = S().newTab(w, { url: "https://elsewhere.com/", profileId: other, background: true });
  S().pinTabs([elsewhere], true);
  assert.equal(S().tabs[elsewhere].profileId, other);
  assert.notEqual(S().windows[w].profileId, other);
  S().closeTab(only);
  assert.equal(S().windows[w], undefined);
});

const shownTab = (w) => S().tabs[activeTabId(S(), w)];

test("with Keep Top Apps running on, ⌘W on a Top App switches away and leaves its page loaded; off, it unloads as before", async () => {
  for (const keep of [true, false]) {
    const { w, ids: [app, other] } = windowWith("app", "other");
    S().pinTabs([app], true);
    S().updateSettings({ keepTopAppsRunning: keep });
    S().activate(app);
    const closed = S().closedTabs.length;
    await closeTab(app);
    assert.equal(activeTabId(S(), w), other, "the regular tab comes forward");
    assert.equal(S().tabs[app].page.kind, keep ? "loaded" : "asleep");
    assert.equal(S().closedTabs.length, closed + (keep ? 0 : 1), "nothing closed, nothing to reopen");
  }
  S().updateSettings({ keepTopAppsRunning: false });
});

test("holding ⌘W with Top Apps kept running ends on a New Tab and never cycles through the tiles", async () => {
  const { w, ids: [a, b, r1] } = windowWith("a", "b", "r1", "r2");
  S().pinTabs([a, b], true);
  S().updateSettings({ keepTopAppsRunning: true });
  S().activate(a);
  S().updateTab(a, { lastActiveAt: Date.now() + 60_000 });
  const visited = [];
  for (let i = 0; i < 8; i++) {
    const t = shownTab(w);
    visited.push(t.pin ? t.url : t.url || "new");
    await closeTab(t.id);
    assert.ok(S().windows[w], `the window stays (step ${i})`);
  }
  assert.equal(shownTab(w).url, "", "a New Tab is in front");
  assert.equal(shownTab(w).pin, null);
  assert.deepEqual(visited.slice(1).filter((u) => u === "https://a.com/" || u === "https://b.com/"), [], `no tile comes back after the first ⌘W: ${visited}`);
  assert.equal(S().tabs[a].page.kind, "loaded");
  assert.equal(S().tabs[b].page.kind, "loaded");
  assert.ok(r1);
  S().updateSettings({ keepTopAppsRunning: false });
});

test("Unload on a kept-running Top App puts it to sleep, and a tile in a split leaves the split loaded", () => {
  const { w, ids: [app, other] } = windowWith("app", "other");
  S().pinTabs([app], true);
  S().updateSettings({ keepTopAppsRunning: true });
  S().activate(app);
  S().closeTabs([app], { keepTopApps: false });
  assert.equal(S().tabs[app].page.kind, "asleep");
  assert.equal(activeTabId(S(), w), other);
  S().activate(app);
  S().createSplit([app, other]);
  S().closeTabs([app]);
  assert.equal(S().tabs[app].page.kind, "loaded", "the tile keeps its page");
  assert.equal(Object.keys(S().splits).length, 0, "and leaves the split");
  assert.equal(activeTabId(S(), w), other);
  S().updateSettings({ keepTopAppsRunning: false });
});

test("with Top Apps kept running, ⌘W on either pane of a tile split with a pinned row keeps the split whole and loaded and switches to the last regular tab", () => {
  for (const pressed of ["app", "row"]) {
    const { w, ids: [app, row, other] } = windowWith("app", "row", "other");
    S().pinTabs([app], true);
    S().pinTabs([row], true, true);
    S().updateSettings({ keepTopAppsRunning: true });
    S().createSplit([app, row]);
    S().activate(other);
    S().activate(pressed === "app" ? app : row);
    const closed = S().closedTabs.length;
    S().closeTabs([pressed === "app" ? app : row]);
    assert.equal(S().tabs[app].page.kind, "loaded", `the tile stays loaded (${pressed})`);
    assert.equal(S().tabs[row].page.kind, "loaded", `the row stays loaded (${pressed})`);
    assert.deepEqual(Object.values(S().splits).map((split) => [...splitTabIdsOf(split)].sort()), [[app, row].sort()], `the split stays whole (${pressed})`);
    assert.equal(activeTabId(S(), w), other, `the last regular tab comes forward (${pressed})`);
    assert.equal(S().closedTabs.length, closed);
    S().updateSettings({ keepTopAppsRunning: false });
  }
});

for (const keep of [false, true]) {
  test(`⌘W on one of two Top Apps split together closes only that pane and leaves the other in front (Keep Top Apps running ${keep ? "on" : "off"})`, async () => {
    const { w, ids: [reading, notes, video] } = windowWith("reading", "notes", "video");
    S().pinTabs([notes, video], true);
    S().updateSettings({ keepTopAppsRunning: keep });
    S().activate(notes);
    S().replaceSplitPane(S().openSplitPane(w).tabId, video);
    assert.equal(activeTabId(S(), w), video);
    await closeTab(video);
    assert.equal(activeTabId(S(), w), notes, "the other Top App stays in front");
    assert.notEqual(activeTabId(S(), w), reading);
    assert.equal(S().tabs[notes].page.kind, "loaded");
    assert.equal(S().tabs[video].page.kind, keep ? "loaded" : "asleep");
    assert.deepEqual(Object.keys(S().splits), [], "the split ends, so opening either Top App shows it alone");
    S().updateSettings({ keepTopAppsRunning: false });
  });
}

test("off, ⌘W on a tile split with a pinned row still unloads the whole split", () => {
  const { w, ids: [app, row, other] } = windowWith("app", "row", "other");
  S().pinTabs([app], true);
  S().pinTabs([row], true, true);
  S().createSplit([app, row]);
  S().activate(app);
  S().closeTabs([app]);
  assert.equal(S().tabs[app].page.kind, "asleep");
  assert.equal(S().tabs[row].page.kind, "asleep");
  assert.equal(activeTabId(S(), w), other);
});

test("top_app_closes_kept_running counts closing the Top App in front, not a close of a tile in the background", async () => {
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { w, ids: [app, back, other] } = windowWith("app", "back", "other");
  S().pinTabs([app, back], true);
  S().updateSettings({ keepTopAppsRunning: true });
  S().activate(back);
  S().activate(app);
  takeTabSleepCounts();
  S().closeTabs([back]);
  assert.equal(takeTabSleepCounts().top_app_closes_kept_running, 0, "a background tile changes nothing");
  await closeTab(app);
  assert.equal(activeTabId(S(), w), other);
  assert.equal(takeTabSleepCounts().top_app_closes_kept_running, 1);
  S().updateSettings({ keepTopAppsRunning: false });
});

test("with Top Apps kept running, closing the last tab beside a running and a cold tile brings a New Tab, not either tile", () => {
  const { w, ids: [running, cold, last] } = windowWith("running", "cold", "last");
  S().pinTabs([running, cold], true);
  S().updateSettings({ keepTopAppsRunning: true });
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [cold]: { ...s.tabs[cold], page: { kind: "idle" } } } }));
  S().activate(running);
  S().activate(last);
  S().closeTabs([last], { lastClosesWindow: true });
  assert.ok(S().windows[w], "the window stays");
  assert.equal(shownTab(w).url, "", "a New Tab is in front");
  assert.equal(S().tabs[running].page.kind, "loaded");
  assert.equal(S().tabs[cold].page.kind, "idle", "the cold tile isn't loaded");
  S().updateSettings({ keepTopAppsRunning: false });
});

test("with Top Apps kept running, a cold tile with no page doesn't count as running", () => {
  const { w, ids: [app, last] } = windowWith("app", "last");
  S().pinTabs([app], true);
  S().updateSettings({ keepTopAppsRunning: true });
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [app]: { ...s.tabs[app], page: { kind: "idle" } } } }));
  S().activate(last);
  const before = viewTabIds(S(), w).length;
  S().closeTabs([last], { lastClosesWindow: true });
  assert.ok(!viewTabIds(S(), w).some((id) => id !== app && S().tabs[id].url === ""), "no New Tab is made to protect a tile with no page");
  assert.ok(viewTabIds(S(), w).length < before);
  S().updateSettings({ keepTopAppsRunning: false });
});

const HELD_PRESSES = 25;

async function holdCloseTab(w, kept) {
  const shown = [];
  for (let i = 0; i < HELD_PRESSES; i++) {
    await closeTab(activeTabId(S(), w));
    assert.ok(S().windows[w], `the window stays (press ${i + 1})`);
    shown.push(activeTabId(S(), w));
  }
  const back = shown.filter((id) => kept.includes(id));
  assert.deepEqual(back, [], `no kept Top App or pane of its split comes forward while ⌘W is held`);
  for (const id of shown.slice(-5)) {
    assert.equal(S().tabs[id]?.url ?? "", "", "it stays on a New Tab");
    assert.equal(S().tabs[id]?.pin ?? null, null);
  }
  assert.equal(shownTab(w).url, "");
  assert.equal(shownTab(w).pin, null);
  for (const id of kept) assert.equal(S().tabs[id].page.kind, "loaded", "every kept pane stays loaded");
}

function topAppSplitWithRow(w, app, row) {
  S().pinTabs([app], true);
  S().pinTabs([row], true, true);
  S().createSplit([app, row]);
}

const heldCloseShapes = {
  "one Top App split with a pinned row, no regular tabs": () => {
    const { w, ids: [app, row] } = windowWith("app", "row");
    topAppSplitWithRow(w, app, row);
    S().activate(app);
    return { w, kept: [app, row] };
  },
  "two Top App splits with pinned rows, no regular tabs": () => {
    const { w, ids: [a, ra, b, rb] } = windowWith("a", "ra", "b", "rb");
    topAppSplitWithRow(w, a, ra);
    topAppSplitWithRow(w, b, rb);
    S().activate(b);
    S().activate(a);
    return { w, kept: [a, ra, b, rb] };
  },
  "a Top App split with a pinned row and regular tabs": () => {
    const { w, ids: [app, row] } = windowWith("app", "row", "r1", "r2");
    topAppSplitWithRow(w, app, row);
    S().activate(app);
    return { w, kept: [app, row] };
  },
  "a plain Top App and regular tabs": () => {
    const { w, ids: [app] } = windowWith("app", "r1", "r2");
    S().pinTabs([app], true);
    S().activate(app);
    return { w, kept: [app] };
  },
  "a plain Top App, no regular tabs": () => {
    const { w, ids: [app] } = windowWith("app");
    S().pinTabs([app], true);
    S().activate(app);
    return { w, kept: [app] };
  },
};

for (const [shape, setUp] of Object.entries(heldCloseShapes)) {
  test(`with Top Apps kept running, holding ⌘W on ${shape} ends on a New Tab and stays there`, async () => {
    const { w, kept } = setUp();
    S().updateSettings({ keepTopAppsRunning: true });
    await holdCloseTab(w, kept);
    S().updateSettings({ keepTopAppsRunning: false });
  });
}

test("with Top Apps kept running, closing the last regular tab beside a kept Top App split brings a New Tab, not the split's row", () => {
  const { w, ids: [app, row, last] } = windowWith("app", "row", "last");
  topAppSplitWithRow(w, app, row);
  S().updateSettings({ keepTopAppsRunning: true });
  S().activate(app);
  S().activate(last);
  S().closeTabs([last], { lastClosesWindow: true });
  assert.ok(S().windows[w]);
  assert.equal(shownTab(w).url, "");
  assert.equal(shownTab(w).pin, null);
  assert.equal(S().tabs[row].page.kind, "loaded");
  S().updateSettings({ keepTopAppsRunning: false });
});

test("off, ⌘W on a tile in a pinned split unloads both panes and keeps the split", async () => {
  for (const pressed of ["app", "row"]) {
    const { w, ids: [app, row, other] } = windowWith("app", "row", "other");
    topAppSplitWithRow(w, app, row);
    S().activate(pressed === "app" ? app : row);
    await closeTab(pressed === "app" ? app : row);
    assert.equal(S().tabs[app].page.kind, "asleep", pressed);
    assert.equal(S().tabs[row].page.kind, "asleep", pressed);
    assert.deepEqual(Object.values(S().splits).map((split) => [...splitTabIdsOf(split)].sort()), [[app, row].sort()], `the split stays (${pressed})`);
    assert.equal(activeTabId(S(), w), other, pressed);
  }
});
