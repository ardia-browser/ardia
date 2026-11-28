import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { animations } from "react-native";
const { useBrowser } = await import("../../state/browser/store.ts");
const { createListHold, LAYOUT_WAIT_MS } = await import("./listHold.ts");
const { takeSidebarResizeCounts } = await import("../../state/telemetry/sidebarResizeCounts.ts");
const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://a.example/" });
const tab = () => S().newTab(w, { url: `https://t${Math.random()}.example/` });
const outwait = () => mock.timers.tick(LAYOUT_WAIT_MS);

function page({ docked = false, room = 46, active = true } = {}) {
  const at = { free: 0, viewport: 600, docked, active };
  const docks = [];
  const hold = createListHold(() => ({
    windowId: w,
    profileId: "default",
    active: at.active,
    free: () => at.free,
    viewport: () => at.viewport,
    docked: () => at.docked,
    dockingAfter: (free) => (at.docked ? free < 1 : free < 12),
    dock: (next) => {
      if (next === at.docked) return;
      docks.push(next);
      at.docked = next;
    },
    undockRoom: () => (at.docked ? room : 0),
  }));
  const layout = ({ content, free = at.free, viewport = at.viewport }) => {
    at.free = free;
    at.viewport = viewport;
    if (content !== undefined) hold.measured(content);
    hold.laidOut();
  };
  layout({ content: 600 });
  return { hold, at, docks, layout };
}

afterEach(() => {
  mock.timers.reset();
  animations.held = false;
  animations.finish();
});

const sliding = () => animations.running.filter((r) => r.value.running === r).map((r) => r.to);
const finishSlide = () => animations.finish();

test("the list keeps its length while the pointer is in, and slides to its own length after it leaves", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  animations.held = true;
  const { hold, layout, docks } = page();
  layout({ content: 900 });
  hold.enter();
  assert.equal(hold.minHeight.__getValue(), 900);
  layout({ content: 1000 });
  assert.equal(hold.minHeight.__getValue(), 1000, "a row added while the pointer is in raises the floor");
  layout({ content: 1000, free: 120 });
  hold.leave();
  assert.deepEqual(sliding(), [880]);
  finishSlide();
  assert.equal(hold.minHeight.__getValue(), 0);
  assert.equal(hold.holding(), false);
  assert.deepEqual(docks, [], "docking waits for the settled layout, not the frame before it");
  layout({ content: 880, free: 0 });
  assert.deepEqual(docks, [true], "docking is checked once the hold ends, even when the free space didn't change");
});

test("leaving, coming back and leaving again acts on the latest layout only", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  animations.held = true;
  const { hold, layout, at, docks } = page({ docked: true });
  layout({ content: 700 });
  hold.enter();
  layout({ free: 300 });
  hold.leave();
  assert.equal(hold.minHeight.__getValue(), 746, "the first leave raises the floor to undock New Tab");
  hold.enter();
  layout({ content: 746, free: 0 });
  hold.leave();
  outwait();
  outwait();
  assert.deepEqual(docks, [], "the first leave's undock never lands");
  assert.equal(at.docked, true);
});

test("a New Tab row that undocks goes first: the list grows by its room, then the scroll view grows, then the list slides", () => {
  animations.held = true;
  const { hold, layout, at, docks } = page({ docked: true });
  layout({ content: 700 });
  hold.enter();
  layout({ free: 300 });
  hold.leave();
  assert.equal(hold.minHeight.__getValue(), 746, "the list grows first, so the scroll view growing next can't clamp its offset");
  assert.deepEqual(docks, []);
  layout({ content: 746, free: 346 });
  assert.deepEqual(docks, [false], "then New Tab undocks");
  assert.deepEqual(sliding(), [], "nothing slides until the undocked layout is in");
  layout({ viewport: 646 });
  assert.deepEqual(sliding(), [646]);
  finishSlide();
  layout({ content: 646, free: 246 });
  assert.equal(hold.holding(), false);
  assert.equal(at.docked, false);
});

test("an undock whose layout never comes still finishes after a short wait", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  animations.held = true;
  const { hold, layout, docks } = page({ docked: true });
  layout({ content: 700 });
  hold.enter();
  layout({ free: 300 });
  hold.leave();
  outwait();
  assert.deepEqual(docks, [false]);
  outwait();
  assert.equal(sliding().length, 1);
  animations.finish();
  outwait();
  assert.equal(hold.holding(), false, "a slide whose last layout never comes lets go rather than sliding again");
});

test("leaving with nothing to give back ends the hold at once and checks docking on the layout after", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, layout, docks } = page();
  layout({ content: 600 });
  hold.enter();
  hold.leave();
  assert.equal(hold.holding(), false);
  assert.equal(hold.minHeight.__getValue(), 0);
  outwait();
  assert.deepEqual(docks, [true]);
});

test("leaving before a closed tab's layout arrives waits for it, so the list slides instead of snapping", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  animations.held = true;
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 1000 });
  hold.enter();
  S().closeTab(gone);
  hold.leave();
  assert.deepEqual(sliding(), [], "nothing settles on the layout from before the close");
  layout({ free: 124 });
  assert.deepEqual(sliding(), [876]);
});

test("a New Tab undock waits for the raised list itself, and is dropped when rows added meanwhile need the dock again", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  animations.held = true;
  const { hold, layout, docks } = page({ docked: true });
  layout({ content: 700 });
  hold.enter();
  layout({ free: 300 });
  hold.leave();
  layout({ free: 350 });
  assert.deepEqual(docks, [], "more free space alone doesn't mean the raised list is in");
  layout({ content: 746, free: 0 });
  outwait();
  assert.deepEqual(docks, [], "the rows now fill the list, so New Tab stays docked");
  assert.equal(hold.holding(), false);
});

test("coming back while the list settles stops it where it is and holds that length", () => {
  animations.held = true;
  const { hold, layout } = page();
  layout({ content: 900 });
  hold.enter();
  layout({ free: 200 });
  hold.leave();
  animations.step(hold.minHeight, 850);
  layout({ content: 850 });
  hold.enter();
  assert.deepEqual(sliding(), []);
  assert.equal(hold.minHeight.__getValue(), 850);
  assert.equal(hold.holding(), true);
});

test("a page that isn't the shown one never holds, and one that stops being shown lets go at once", () => {
  const hidden = page({ active: false });
  hidden.layout({ content: 900 });
  hidden.hold.enter();
  assert.equal(hidden.hold.holding(), false);
  assert.equal(hidden.hold.minHeight.__getValue(), 0);
  const shown = page();
  shown.layout({ content: 900 });
  shown.hold.enter();
  shown.layout({ free: 200 });
  shown.hold.reset();
  assert.equal(shown.hold.holding(), false);
  assert.equal(shown.hold.minHeight.__getValue(), 0);
});

test("the hold counts once per visit, only when a tab of this page closed while the pointer was in", () => {
  setConsentPeriod(true, "list-hold");
  takeSidebarResizeCounts();
  const keep = tab();
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 900 });
  hold.enter();
  layout({ free: 40 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 0, "a fold or a resize frees room without closing a tab");
  S().closeTab(gone);
  hold.laidOut();
  layout({ free: 80 });
  S().closeTab(keep);
  layout({ free: 120 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 1);
  hold.leave();
  hold.enter();
  const opened = tab();
  layout({ free: 80 });
  S().closeTab(opened);
  layout({ free: 120 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 1, "a tab opened during the visit, taking free space without growing the list, counts when it closes");
  setConsentPeriod(false, null);
});

test("a resize of the scroll view doesn't stand in for the layout of a tab closed just before leaving", () => {
  animations.held = true;
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 1000 });
  hold.enter();
  S().closeTab(gone);
  hold.leave();
  hold.resized();
  assert.deepEqual(sliding(), []);
  layout({ free: 124 });
  assert.deepEqual(sliding(), [876]);
});

test("a close made before sharing was on isn't counted in the sharing period that follows", () => {
  setConsentPeriod(false, null);
  takeSidebarResizeCounts();
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 900 });
  hold.enter();
  S().closeTab(gone);
  setConsentPeriod(true, "after-close");
  layout({ free: 40 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 0);
  setConsentPeriod(false, null);
});

test("a close that frees no room isn't counted by a fold that frees room later", () => {
  setConsentPeriod(true, "fold-later");
  takeSidebarResizeCounts();
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 900 });
  hold.enter();
  S().closeTab(gone);
  layout({ free: 0 });
  layout({ free: 40 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 0);
  setConsentPeriod(false, null);
});

test("deactivating after the hold let go cancels its last docking check", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, layout, docks } = page();
  layout({ content: 600 });
  hold.enter();
  hold.leave();
  hold.reset();
  outwait();
  assert.deepEqual(docks, []);
});

test("a New Tab undock waits for both measurements of the raised list, whichever arrives first", () => {
  animations.held = true;
  const { hold, layout, docks } = page({ docked: true });
  layout({ content: 650 });
  hold.enter();
  layout({ free: 74 });
  hold.leave();
  assert.equal(hold.minHeight.__getValue(), 696);
  layout({ content: 696 });
  assert.deepEqual(docks, [], "the content alone isn't the whole raised layout");
  assert.deepEqual(sliding(), []);
  layout({ free: 120 });
  assert.deepEqual(docks, [false]);
});

test("a tab closed after the pointer left settles as the list does without a hold", () => {
  animations.held = true;
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 1000 });
  hold.enter();
  layout({ free: 124 });
  hold.leave();
  S().closeTab(gone);
  finishSlide();
  assert.equal(hold.minHeight.__getValue(), 0, "nothing is under the pointer any more, so the close isn't held");
});

test("a close made before sharing was on isn't counted when the pointer comes in after sharing starts", () => {
  setConsentPeriod(false, null);
  takeSidebarResizeCounts();
  const gone = tab();
  const { hold, layout } = page();
  layout({ content: 900 });
  S().closeTab(gone);
  setConsentPeriod(true, "enter-after");
  hold.enter();
  layout({ free: 40 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 0);
  setConsentPeriod(false, null);
});

test("closing a tab hidden in a collapsed group isn't counted by a fold that frees room right after", () => {
  setConsentPeriod(true, "collapsed-close");
  takeSidebarResizeCounts();
  const hiddenTab = tab();
  const other = tab();
  const g = S().createGroup([hiddenTab, other], { name: "G" });
  S().updateGroup(g, { collapsed: true });
  tab();
  const { hold, layout } = page();
  layout({ content: 900 });
  hold.enter();
  S().closeTab(hiddenTab);
  layout({ free: 40 });
  assert.equal(takeSidebarResizeCounts().sidebar_list_held_under_pointer, 0);
  setConsentPeriod(false, null);
});
