import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { pagerFor } = await import("./profilePager.ts");
const { PagerMachine } = await import("../../../../../packages/ardiacore/src/pagerModel.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
const { libraryAvailable, libraryOf, useLibrary } = await import("../library/library.ts");
const { closeLibrary, openLibrary, toggleLibrary } = await import("../library/actions.ts");
const { libraryPagerIntent } = await import("../library/pagerBridge.ts");
const { takeLibraryCounts } = await import("../telemetry/libraryCounts.ts");
const { setSharing } = await import("../telemetry/client.ts");
const { finishQuitSaves } = await import("../app/quit.ts");

globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(performance.now()), 0);
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };

const hop = () => new Promise((resolve) => setTimeout(resolve, 0));
const hops = async (count) => {
  for (let i = 0; i < count; i += 1) await hop();
};

const machines = new Map();

function frameClock() {
  let time = 0;
  return {
    now: () => time,
    requestFrame: (frame) => setTimeout(() => frame((time += 1 / 120)), 1),
    cancelFrame: (id) => clearTimeout(id),
    reducedMotion: () => false,
  };
}

const swipe = ardiaCoreNativeModules.ArdiaSwipe;
const nativeCalls = {
  leadPager: async (key, open, animated) => (await hop(), machines.get(key)?.lead(open, animated) ?? false),
  stepPager: async (key, delta, wrap, order) => (await hop(), machines.get(key)?.step(delta, wrap, order) ?? false),
  selectPager: async (key, profileId, order) => (await hop(), machines.get(key)?.select(profileId, order) ?? false),
  switchPager: async (key, index, order) => (await hop(), machines.get(key)?.switchTo(index, order) ?? false),
  pagerState: (key) => machines.get(key)?.snapshot() ?? null,
};
Object.assign(swipe, nativeCalls);

function libraryWindow() {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"] });
  S().updateSettings({ sidebarLibrary: true, tabLayout: "sidebar", autoHideTabs: false });
  const windowId = S().createWindow({ url: "https://a.example/" });
  takeLibraryCounts();
  return windowId;
}

function mountSidebar(windowId, { propDelay = 0 } = {}) {
  const profilePager = pagerFor(windowId);
  const detachSurface = profilePager.attach();
  let mounted = true;
  const machine = new PagerMachine(frameClock(), {
    position: () => {},
    state: (event) => setTimeout(() => mounted && profilePager.onNativeState(event), 0),
  });
  machines.set(windowId, machine);
  const render = () => {
    const s = S();
    if (!mounted || !s.windows[windowId]) return;
    const leading = libraryAvailable(s, windowId);
    machine.configure({
      selected: s.profileOrder.indexOf(s.windows[windowId].profileId),
      count: s.profileOrder.length,
      ack: profilePager.state.getState().ack,
      order: s.profileOrder,
      leading,
      library: leading && libraryOf(windowId).open,
    });
  };
  render();
  const later = () => setTimeout(render, propDelay);
  const unsubscribe = [useBrowser.subscribe(later), useLibrary.subscribe(later), profilePager.state.subscribe(later)];
  return {
    machine,
    swipeIntoLibrary() {
      machine.beginTracking(() => {});
      machine.trackTo(-0.7);
      machine.settle(-1, 0);
    },
    unmount() {
      mounted = false;
      unsubscribe.forEach((stop) => stop());
      machine.stop();
      machines.delete(windowId);
      detachSurface();
    },
  };
}

async function quiet(machine) {
  await hops(4);
  for (let i = 0; i < 400 && machine.snapshot().phase !== "idle"; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  await hops(4);
}

async function whileSharing(run) {
  const fetched = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  setSharing(true, "settings");
  try {
    return await run();
  } finally {
    setSharing(false, "settings");
    globalThis.fetch = fetched;
  }
}

function withLeadPager(replacement, run) {
  swipe.leadPager = replacement;
  return Promise.resolve(run()).finally(() => (swipe.leadPager = nativeCalls.leadPager));
}

test("a window that exists keeps one pager; a missing window gets a throwaway that isn't kept", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(pagerFor(w), pagerFor(w));
  assert.notEqual(pagerFor("w-gone"), pagerFor("w-gone"));
});

test("the Library opens and closes where the pager lands, and the button's open and close are counted once each", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    openLibrary(windowId, "button");
    assert.equal(libraryOf(windowId).open, false, "nothing is open until the pager lands");
    assert.equal(libraryPagerIntent(windowId)?.open, true);
    await quiet(sidebar.machine);
    assert.deepEqual([libraryOf(windowId).open, sidebar.machine.snapshot().leading], [true, true]);
    toggleLibrary(windowId, "button");
    await quiet(sidebar.machine);
    assert.deepEqual([libraryOf(windowId).open, sidebar.machine.snapshot().leading], [false, false]);
    const counts = takeLibraryCounts();
    assert.deepEqual([counts.library_opens_button, counts.library_closes_button], [1, 1]);
    sidebar.unmount();
  }));

test("an open that lands after the sidebar hid leaves the Library closed and leads the pager back, so it stays closed when the sidebar returns", () =>
  whileSharing(async () => {
  const windowId = libraryWindow();
  const sidebar = mountSidebar(windowId, { propDelay: 50 });
  await quiet(sidebar.machine);
  sidebar.swipeIntoLibrary();
  S().updateSettings({ autoHideTabs: true });
  await hops(4);
  assert.equal(libraryOf(windowId).open, false, "the Library opened where it can't show");
  assert.equal(sidebar.machine.snapshot().leading, false, "the pager stayed on the Library");
  sidebar.unmount();
  await hops(20);
  S().updateSettings({ autoHideTabs: false });
  const shown = mountSidebar(windowId);
  await quiet(shown.machine);
  assert.deepEqual([libraryOf(windowId).open, shown.machine.snapshot().leading], [false, false]);
  const counts = takeLibraryCounts();
  assert.deepEqual([counts.library_opens_refused, counts.library_opens_swipe], [1, 0]);
  shown.unmount();
  }));

test("a swipe into the Library while a command's open is on its way counts as a swipe", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    await withLeadPager(async (key, open, animated) => (await hops(6), machines.get(key)?.lead(open, animated) ?? false), async () => {
      toggleLibrary(windowId, "command");
      sidebar.swipeIntoLibrary();
      await quiet(sidebar.machine);
      await hops(10);
    });
    const counts = takeLibraryCounts();
    assert.equal(libraryOf(windowId).open, true);
    assert.deepEqual([counts.library_opens_swipe, counts.library_opens_command], [1, 0]);
    sidebar.unmount();
  }));

test("Escape right after a swipe lands in the Library closes it", async () => {
  const windowId = libraryWindow();
  const sidebar = mountSidebar(windowId);
  await quiet(sidebar.machine);
  sidebar.swipeIntoLibrary();
  closeLibrary(windowId, "escape");
  await quiet(sidebar.machine);
  assert.deepEqual([libraryOf(windowId).open, sidebar.machine.snapshot().leading], [false, false]);
  sidebar.unmount();
});

test("Toggle Library right after a swipe lands closes the Library instead of counting a command open", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    sidebar.swipeIntoLibrary();
    toggleLibrary(windowId, "command");
    await quiet(sidebar.machine);
    const counts = takeLibraryCounts();
    assert.equal(libraryOf(windowId).open, false);
    assert.equal(counts.library_opens_command, 0);
    sidebar.unmount();
  }));

test("quitting while an open is on its way leaves the Library closed", async () => {
  const windowId = libraryWindow();
  const sidebar = mountSidebar(windowId);
  await quiet(sidebar.machine);
  openLibrary(windowId, "command");
  await finishQuitSaves(2000);
  await quiet(sidebar.machine);
  assert.deepEqual([libraryOf(windowId).open, sidebar.machine.snapshot().leading], [false, false]);
  sidebar.unmount();
});

test("a pager call that throws at once falls back to opening the Library and leaves nothing queued", async () => {
  const windowId = libraryWindow();
  const sidebar = mountSidebar(windowId);
  await quiet(sidebar.machine);
  await withLeadPager(
    () => {
      throw new Error("the native module is gone");
    },
    async () => {
      openLibrary(windowId, "command");
      await hops(4);
    },
  );
  assert.equal(libraryOf(windowId).open, true);
  assert.equal(libraryPagerIntent(windowId)?.open, sidebar.machine.snapshot().leading);
  sidebar.unmount();
});

test("Escape, then the layout forcing the Library shut, counts the Escape", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    openLibrary(windowId, "command");
    await quiet(sidebar.machine);
    takeLibraryCounts();
    await withLeadPager(async (key, open, animated) => (await hops(6), machines.get(key)?.lead(open, animated) ?? false), async () => {
      closeLibrary(windowId, "escape");
      closeLibrary(windowId, "layout");
      await quiet(sidebar.machine);
      await hops(10);
    });
    const counts = takeLibraryCounts();
    assert.equal(libraryOf(windowId).open, false);
    assert.deepEqual([counts.library_closes_escape, counts.library_closes_layout], [1, 0]);
    sidebar.unmount();
  }));

test("Escape, then closing the window before the pager lands, counts the Escape", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    S().createWindow({ url: "https://b.example/" });
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    openLibrary(windowId, "command");
    await quiet(sidebar.machine);
    takeLibraryCounts();
    await withLeadPager(async (key, open, animated) => (await hops(6), machines.get(key)?.lead(open, animated) ?? false), async () => {
      closeLibrary(windowId, "escape");
      S().closeWindow(windowId);
      await hops(12);
    });
    const counts = takeLibraryCounts();
    assert.deepEqual([counts.library_closes_escape, counts.library_closes_window_closed], [1, 0]);
    assert.equal(useLibrary.getState().windows[windowId], undefined);
    sidebar.unmount();
  }));

test("Escape while a swipe into the Library is still settling is counted as Escape, not swipe", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    sidebar.swipeIntoLibrary();
    await hops(3);
    closeLibrary(windowId, "escape");
    await quiet(sidebar.machine);
    await hops(10);
    const counts = takeLibraryCounts();
    assert.equal(libraryOf(windowId).open, false);
    assert.deepEqual([counts.library_opens_swipe, counts.library_closes_escape, counts.library_closes_swipe], [1, 1, 0]);
    sidebar.unmount();
  }));

test("a swipe cut short by a new profile doesn't claim the button's open that follows", () =>
  whileSharing(async () => {
    const windowId = libraryWindow();
    const sidebar = mountSidebar(windowId);
    await quiet(sidebar.machine);
    sidebar.machine.beginTracking(() => {});
    sidebar.machine.trackTo(-0.4);
    await hops(3);
    S().createProfile({ name: "Play" });
    await quiet(sidebar.machine);
    openLibrary(windowId, "button");
    await quiet(sidebar.machine);
    await hops(10);
    const counts = takeLibraryCounts();
    assert.equal(libraryOf(windowId).open, true);
    assert.deepEqual([counts.library_opens_button, counts.library_opens_swipe], [1, 0]);
    sidebar.unmount();
  }));
