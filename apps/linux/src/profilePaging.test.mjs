import assert from "node:assert/strict";
import test from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(performance.now()), 4);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Pager } = await import("./shims/web/motion/pager.ts");
const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { initialHostSession } = await import("./hostSession.ts");
const { stepAction } = await import("../../../packages/ardiacore/src/pagerModel.ts");
const { ardiaCoreNativeModules } = await import("../../browser/src/test-native/ardiacore.ts");
const { pagerFor } = await import("../../browser/src/state/windows/profilePager.ts");
const { libraryAvailable, libraryOf, useLibrary } = await import("../../browser/src/state/library/library.ts");
const { closeLibrary, toggleLibrary } = await import("../../browser/src/state/library/actions.ts");
const { takeLibraryCounts } = await import("../../browser/src/state/telemetry/libraryCounts.ts");
const telemetry = await import("../../browser/src/state/telemetry/client.ts");

const whileSharing = async (run) => {
  telemetry.loadChoice();
  telemetry.setSharing(true, "settings");
  try {
    return await run();
  } finally {
    telemetry.setSharing(false, "settings");
  }
};

const S = () => useBrowser.getState();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ORDER = ["default", "work", "side"];
let keys = 0;

function pager() {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER });
  return { named, area, states, positions };
}

const settled = (named) => new Promise((resolve) => {
  const poll = () => named.snapshot().phase === "idle" ? resolve() : setTimeout(poll, 5);
  poll();
});

test("a swipe pages to the next profile whatever its engine profile", async () => {
  const { named, area } = pager();
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 300, -1, 0.05);
  named.input(area, "ended", 300, -1, 0.3);
  await settled(named);
  assert.equal(named.snapshot().selected, 1);
  assert.equal(named.snapshot().profileId, "work");
});

test("a short swipe springs back to the current profile", async () => {
  const { named, area } = pager();
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 40, -1, 0.2);
  named.input(area, "ended", 40, -1, 0.4);
  await settled(named);
  assert.equal(named.snapshot().selected, 0);
});

test("menu and keyboard switches page to any profile", async () => {
  const { named } = pager();
  assert.equal(named.switchTo(1, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 1);
  assert.equal(named.step(1, false, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 2);
});

function libraryPager() {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: (position, leading) => positions.push({ position, leading }), onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: false });
  return { named, area, states, positions };
}

const swipe = async (named, area, distance, direction) => {
  named.input(area, "began", 0, direction, 0);
  named.input(area, "changed", distance, direction, 0.05);
  named.input(area, "ended", distance, direction, 0.3);
  await settled(named);
};

const BACK = 1;
const FORWARD = -1;

test("swiping back from the first profile opens the Library and reports no profile", async () => {
  const { named, area, states } = libraryPager();
  await flush();
  const before = states.length;
  await swipe(named, area, 300, BACK);
  const selected = states.slice(before).find((e) => e.phase === "selected");
  assert.deepEqual([selected.selected, selected.leading, selected.profileId], [-1, true, null]);
  const snapshot = named.snapshot();
  assert.deepEqual([snapshot.selected, snapshot.position, snapshot.leading, snapshot.lead, snapshot.profileId], [-1, -1, true, 1, null]);
});

test("without a Library page a swipe back from the first profile rubber-bands and stays", async () => {
  const { named, area } = pager();
  await swipe(named, area, 300, BACK);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId], [0, false, "default"]);
  assert.equal(named.debug().anchor, null);
});

test("a swipe past the Library rubber-bands its progress and settles back on the Library", async () => {
  const { named, area, positions } = libraryPager();
  await swipe(named, area, 300, BACK);
  const start = positions.length;
  named.input(area, "began", 0, BACK, 1);
  named.input(area, "changed", 800, BACK, 1.05);
  const pulled = positions.at(-1);
  assert.equal(pulled.position, 0);
  assert.ok(pulled.leading > 1.1 && pulled.leading < 1.5, `lead ${pulled.leading}`);
  named.input(area, "ended", 800, BACK, 1.3);
  await settled(named);
  assert.ok(positions.slice(start).every((p) => p.position === 0));
  assert.deepEqual([named.snapshot().leading, named.snapshot().lead], [true, 1]);
});

test("a long swipe forward from the Library pages one step, back to the profile it came from", async () => {
  const { named, area, states } = libraryPager();
  await swipe(named, area, 300, BACK);
  await swipe(named, area, 2000, FORWARD);
  const done = states.at(-1);
  assert.deepEqual([done.phase, done.selected, done.leading, done.profileId], ["settled", 0, false, "default"]);
  assert.deepEqual([named.snapshot().lead, named.debug().anchor], [0, null]);
});

test("lead opens the Library from a later profile and closing returns to it", async () => {
  const { named, states } = libraryPager();
  named.switchTo(2);
  await settled(named);
  assert.equal(named.lead(true), true);
  await flush();
  const opened = states.at(-1);
  assert.deepEqual([opened.phase, opened.selected, opened.leading, opened.profileId], ["selected", -1, true, null]);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().position, named.snapshot().lead, named.debug().home, named.debug().pagePosition], [-1, 1, 1, 2, 2]);
  assert.equal(named.lead(false), true);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [2, false, "side", null]);
});

test("lead refuses to open where the pager has no Library page", () => {
  const { named } = pager();
  assert.equal(named.lead(true), false);
  assert.equal(named.lead(false), true);
});

test("stepping back from the first profile opens the Library, stepping forward closes it", async () => {
  const { named } = libraryPager();
  assert.equal(named.step(-1, false, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().leading, true);
  assert.equal(named.step(-1, false, ORDER), true);
  assert.equal(named.snapshot().phase, "idle");
  assert.equal(named.step(1, false, ORDER), true);
  await settled(named);
  assert.deepEqual([named.snapshot().leading, named.snapshot().profileId], [false, "default"]);
});

test("selecting a profile at the Library re-anchors it there, and switching closes onto the new profile", async () => {
  const { named, states } = libraryPager();
  named.lead(true);
  await settled(named);
  assert.equal(named.select("side", ORDER), true);
  await flush();
  const reanchored = states.at(-1);
  assert.deepEqual([reanchored.phase, reanchored.selected, reanchored.leading, reanchored.profileId], ["selected", -1, true, null]);
  assert.deepEqual([named.snapshot().position, named.snapshot().lead, named.debug().anchor, named.debug().home], [1, 1, 2, 2]);
  assert.equal(named.switchTo(1), true);
  await settled(named);
  const done = states.at(-1);
  assert.deepEqual([done.phase, done.selected, done.leading, done.profileId], ["settled", 1, false, "work"]);
  assert.equal(named.debug().anchor, null);
});

test("the library prop opens the Library and turning off the leading page closes it", async () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: false });
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.debug().home], [-1, true, 1]);
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false });
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [1, false, "work", null]);
});

test("Linux switches an isolated profile in place, like a profile sharing the window's data", () => {
  S().hydrate(initialHostSession({ bootstrap: { windowId: "main", profileId: "default", startup: false } }, null));
  const work = S().createProfile({ name: "Work" });
  const side = S().createProfile({ name: "Side", shareWith: "default" });
  const before = Object.keys(S().windows).length;
  S().switchProfile("main", work);
  assert.equal(S().windows.main.profileId, work);
  S().switchProfile("main", side);
  assert.equal(S().windows.main.profileId, side);
  assert.equal(Object.keys(S().windows).length, before);
});

test("reordering profiles while the Library is open keeps it open over the moved profile", async () => {
  const { named } = libraryPager();
  named.lead(true);
  await settled(named);
  named.configure({ key: named.key, selected: 0, count: 3, ack: 0, order: ["work", "default", "side"], leading: true, library: true });
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().lead, named.debug().anchor, named.debug().home], [-1, true, 1, 1, 1]);
  assert.equal(named.lead(false), true);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().profileId], [1, "default"]);
});

test("closing the Library without animation lands on its profile at once", async () => {
  const { named, states } = libraryPager();
  named.switchTo(1);
  await settled(named);
  named.lead(true);
  await settled(named);
  assert.equal(named.lead(false, false), true);
  await flush();
  const closed = states.at(-1);
  assert.deepEqual([closed.phase, closed.selected, closed.leading, closed.profileId], ["selected", 1, false, "work"]);
  assert.deepEqual([named.snapshot().phase, named.snapshot().position, named.snapshot().lead, named.debug().anchor], ["idle", 1, 0, null]);
});

test("Previous and Next Profile with the Library open page from the profile the Library opened on", async () => {
  for (const [delta, landing] of [[-1, "default"], [1, "side"]]) {
    const { named } = libraryPager();
    named.switchTo(1);
    await settled(named);
    named.lead(true);
    await settled(named);
    assert.equal(named.step(delta, true, ORDER), true);
    await settled(named);
    assert.deepEqual([named.snapshot().leading, named.snapshot().profileId], [false, landing]);
  }
});

test("a pager configured while the Library is open starts on the Library and says so", async () => {
  const states = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: () => {}, onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().lead, named.debug().home], [-1, true, 1, 1]);
  await flush();
  assert.deepEqual(states.map((e) => [e.leading, e.selected]), [[true, -1]]);
});

test("turning off the leading page mid-swipe keeps a forward swipe from the first profile going forward", async () => {
  const { named, area } = libraryPager();
  named.input(area, "began", 0, FORWARD, 0);
  named.input(area, "changed", 300, FORWARD, 0.05);
  named.input(area, "ended", 300, FORWARD, 0.3);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false });
  await settled(named);
  assert.deepEqual([named.snapshot().profileId, named.debug().anchor], ["work", null]);
});

test("turning off the leading page at the Library settles home once, however often it is configured", async () => {
  const { named } = libraryPager();
  named.switchTo(1);
  await settled(named);
  named.lead(true);
  await settled(named);
  const cancel = globalThis.cancelAnimationFrame;
  let restarts = 0;
  const off = { key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false };
  named.configure(off);
  globalThis.cancelAnimationFrame = (id) => (restarts++, cancel(id));
  try {
    named.configure(off);
    named.configure(off);
  } finally {
    globalThis.cancelAnimationFrame = cancel;
  }
  await settled(named);
  assert.equal(restarts, 0);
  assert.deepEqual([named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [false, "work", null]);
});

test("a reorder during a forward swipe from the first profile keeps the profile it is heading to", () => {
  const { named, area } = libraryPager();
  named.input(area, "began", 0, FORWARD, 0);
  named.input(area, "changed", 300, FORWARD, 0.05);
  named.input(area, "ended", 300, FORWARD, 0.3);
  named.configure({ key: named.key, selected: 0, count: 3, ack: 0, order: ["side", "work", "default"], leading: true, library: false });
  assert.equal(named.snapshot().profileId, "work");
});

test("stepAction wraps from the Library's own profile", () => {
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, -1, true), { kind: "switch", index: 0 });
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, 1, true), { kind: "switch", index: 2 });
  assert.deepEqual(stepAction({ anchor: null, selected: 0, leading: true, count: 1 }, 1, true), { kind: "stay" });
});

const hop = () => new Promise((resolve) => setTimeout(resolve, 0));
const swipeModule = ardiaCoreNativeModules.ArdiaSwipe;
Object.assign(swipeModule, {
  leadPager: async (key, open, animated) => (await hop(), Pager.existing(key)?.lead(open, animated) ?? false),
  stepPager: async (key, delta, wrap, order) => (await hop(), Pager.existing(key)?.step(delta, wrap, order) ?? false),
  selectPager: async (key, profileId, order) => (await hop(), Pager.existing(key)?.select(profileId, order) ?? false),
  switchPager: async (key, index, order) => (await hop(), Pager.existing(key)?.switchTo(index, order) ?? false),
  pagerState: (key) => Pager.existing(key)?.snapshot() ?? null,
});

function libraryWindow() {
  S().hydrate(initialHostSession({ bootstrap: { windowId: `lib-${++keys}`, profileId: "default", startup: false } }, null));
  S().updateSettings({ sidebarLibrary: true, tabLayout: "sidebar", autoHideTabs: false });
  const windowId = Object.keys(S().windows)[0];
  takeLibraryCounts();
  return windowId;
}

function mountArea(windowId, { propDelay = 0 } = {}) {
  const profilePager = pagerFor(windowId);
  const detachSurface = profilePager.attach();
  let mounted = true;
  const area = { pageWidth: () => 200, attached: () => true, onPosition: () => {}, onState: (e) => setTimeout(() => mounted && profilePager.onNativeState(e), 0) };
  const named = Pager.named(windowId);
  named.attach(area);
  const render = () => {
    const s = S();
    if (!mounted || !s.windows[windowId]) return;
    const leading = libraryAvailable(s, windowId);
    named.configure({ key: windowId, selected: s.profileOrder.indexOf(s.windows[windowId].profileId), count: s.profileOrder.length, ack: profilePager.state.getState().ack, order: s.profileOrder, leading, library: leading && libraryOf(windowId).open });
  };
  render();
  const later = () => setTimeout(render, propDelay);
  const unsubscribe = [useBrowser.subscribe(later), useLibrary.subscribe(later), profilePager.state.subscribe(later)];
  return {
    named,
    unmount() {
      mounted = false;
      unsubscribe.forEach((stop) => stop());
      named.detach(area);
      detachSurface();
    },
  };
}

const quiet = async (named) => {
  for (let i = 0; i < 4; i++) await hop();
  await settled(named);
  for (let i = 0; i < 4; i++) await hop();
};

test("a double Toggle Library within the native round trip closes the Library again", async () => {
  const windowId = libraryWindow();
  const { named, unmount } = mountArea(windowId);
  toggleLibrary(windowId, "command");
  toggleLibrary(windowId, "command");
  await quiet(named);
  assert.deepEqual([libraryOf(windowId).open, named.snapshot().leading], [false, false]);
  unmount();
});

test("a Library reopened after its pager was rebuilt stays open", async () => {
  const windowId = libraryWindow();
  let mounted = mountArea(windowId);
  toggleLibrary(windowId, "command");
  await quiet(mounted.named);
  assert.equal(libraryOf(windowId).open, true);
  mounted.unmount();
  mounted = mountArea(windowId);
  await quiet(mounted.named);
  assert.equal(mounted.named.snapshot().leading, true);
  closeLibrary(windowId, "escape");
  await quiet(mounted.named);
  assert.deepEqual([libraryOf(windowId).open, mounted.named.snapshot().leading], [false, false]);
  toggleLibrary(windowId, "command");
  await quiet(mounted.named);
  assert.deepEqual([libraryOf(windowId).open, mounted.named.snapshot().leading], [true, true]);
  mounted.unmount();
});

test("a Library request that lands without moving the pager leaves no cause for the next swipe", () => whileSharing(async () => {
  takeLibraryCounts();
  const windowId = libraryWindow();
  const { named, unmount } = mountArea(windowId);
  const lead = swipeModule.leadPager;
  swipeModule.leadPager = async () => (await hop(), true);
  toggleLibrary(windowId, "command");
  await quiet(named);
  swipeModule.leadPager = lead;
  assert.equal(libraryOf(windowId).open, false);
  named.lead(true);
  await quiet(named);
  const counts = takeLibraryCounts();
  assert.deepEqual([libraryOf(windowId).open, counts.library_opens_swipe, counts.library_opens_command], [true, 1, 0]);
  unmount();
}));

const withLead = async (lead, run) => {
  const original = swipeModule.leadPager;
  swipeModule.leadPager = lead;
  try {
    return await run();
  } finally {
    swipeModule.leadPager = original;
  }
};

test("a Library closed as its pager unmounts, then reopened by a swipe on the rebuilt pager, stays open", async () => {
  const windowId = libraryWindow();
  let mounted = mountArea(windowId);
  toggleLibrary(windowId, "command");
  await quiet(mounted.named);
  const gone = mounted;
  await withLead(async (key, open, animated) => {
    await hop();
    const ok = Pager.existing(key)?.lead(open, animated) ?? false;
    gone.unmount();
    await hop();
    return ok;
  }, async () => {
    closeLibrary(windowId, "layout");
    for (let i = 0; i < 6; i++) await hop();
  });
  assert.equal(libraryOf(windowId).open, false);
  mounted = mountArea(windowId);
  await quiet(mounted.named);
  mounted.named.lead(true);
  await quiet(mounted.named);
  assert.deepEqual([libraryOf(windowId).open, mounted.named.snapshot().leading], [true, true]);
  mounted.unmount();
});

test("a Library opened while a profile selection fails still opens", () => whileSharing(async () => {
  takeLibraryCounts();
  const windowId = libraryWindow();
  S().createProfile({ name: "Work" });
  const { named, unmount } = mountArea(windowId);
  await quiet(named);
  const select = swipeModule.selectPager;
  swipeModule.selectPager = async () => (await hop(), await hop(), await hop(), false);
  try {
    toggleLibrary(windowId, "command");
    S().switchProfile(windowId, S().profileOrder[1]);
    await quiet(named);
  } finally {
    swipeModule.selectPager = select;
  }
  await quiet(named);
  assert.deepEqual([libraryOf(windowId).open, named.snapshot().leading, takeLibraryCounts().library_opens_command], [true, true, 1]);
  unmount();
}));

test("a double toggle whose open the pager refuses before its Library page arrives ends closed", async () => {
  const windowId = libraryWindow();
  S().updateSettings({ sidebarLibrary: false });
  const { named, unmount } = mountArea(windowId, { propDelay: 30 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  S().updateSettings({ sidebarLibrary: true });
  toggleLibrary(windowId, "command");
  toggleLibrary(windowId, "command");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await quiet(named);
  assert.deepEqual([libraryOf(windowId).open, named.snapshot().leading], [false, false]);
  unmount();
});

test("turning the Library off while an open is on its way leaves it closed", async () => {
  const windowId = libraryWindow();
  const { named, unmount } = mountArea(windowId);
  await quiet(named);
  await withLead(async (key, open, animated) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Pager.existing(key)?.lead(open, animated) ?? false;
  }, async () => {
    toggleLibrary(windowId, "command");
    S().updateSettings({ sidebarLibrary: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await quiet(named);
  });
  assert.deepEqual([libraryOf(windowId).open, named.snapshot().leading], [false, false]);
  unmount();
});

test("the library prop with a new selection lands on the Library over that profile", () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 2, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  assert.deepEqual([named.snapshot().leading, named.debug().home], [true, 2]);
});

test("the library prop with a reorder ends on the Library", async () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 1, count: 3, ack: 0, order: ["work", "default", "side"], leading: true, library: true });
  await settled(named);
  assert.deepEqual([named.snapshot().leading, named.debug().home], [true, 1]);
});

test("a Library request that lands after its window closed leaves no Library state behind", async () => {
  const windowId = libraryWindow();
  const { named, unmount } = mountArea(windowId);
  await quiet(named);
  await withLead(async () => (await hop(), await hop(), false), async () => {
    toggleLibrary(windowId, "command");
    unmount();
    S().hydrate(initialHostSession({ bootstrap: { windowId: `lib-${++keys}`, profileId: "default", startup: false } }, null));
    for (let i = 0; i < 6; i++) await hop();
  });
  assert.equal(useLibrary.getState().windows[windowId], undefined);
});

test("a swipe whose area goes away mid-drag springs back instead of staying in the drag", async () => {
  const { named, area } = pager();
  const other = { pageWidth: () => 200, attached: () => true, onPosition: () => {}, onState: () => {} };
  named.attach(other);
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 120, -1, 0.05);
  assert.equal(named.snapshot().phase, "tracking");
  named.detach(area);
  assert.notEqual(named.snapshot().phase, "tracking");
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().position], [0, 0]);
});
