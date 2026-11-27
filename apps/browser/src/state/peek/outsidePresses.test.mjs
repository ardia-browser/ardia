import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { forgetPeekStage, notePeekStageState } = await import("./gesturePresses.ts");
const { shownPeek } = await import("./peek.ts");
const { cancelPeekOutsidePress, endPeekOutsidePress, movePeekOutsidePress, OUTSIDE_CLICK_SLOP, pressPeekOutsideOnDragRegion, startPeekOutsidePress } = await import("./outsidePresses.ts");
const { notePressSwitchesShownPage } = await import("./pressSwitches.ts");
after(() => client.setSharing(false, "settings"));
const S = () => useBrowser.getState();
const AT = { x: 40, y: 300 };

async function sentCloses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.reduce((sum, e) => sum + (e.peek_outside_close_presses ?? 0), 0);
}

function windowWithTwoPeeks() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const other = S().openPeek(b, "https://peek.example/b");
  S().activate(a);
  const shown = S().openPeek(a, "https://peek.example/a");
  return { w, a, b, shown, other };
}

const click = (w, at = AT, button = 0, during = () => {}) => {
  startPeekOutsidePress(w, AT, button);
  during();
  endPeekOutsidePress(w, at);
};

test("a click in the sidebar that leaves the same tab shown closes its Peek, and is counted", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentCloses();
  const { w, a, b, other } = windowWithTwoPeeks();
  click(w);
  assert.equal(S().peeks[a], undefined, "the shown Peek closed");
  assert.equal(S().peeks[b]?.tabId, other, "another tab's hidden Peek stays");
  assert.equal((await sentCloses()) - before, 1);
});

test("a click that switches to another tab keeps the Peek with its tab and shows that tab's own, closing neither", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentCloses();
  const { w, a, b, shown, other } = windowWithTwoPeeks();
  click(w, AT, 0, () => S().activate(b));
  assert.equal(S().peeks[a]?.tabId, shown, "the Peek stays with the tab it was opened from");
  assert.equal(shownPeek(S(), w)?.tabId, other, "the new tab's Peek shows and stays open");
  S().activate(a);
  assert.equal(shownPeek(S(), w)?.tabId, shown, "going back shows the same Peek");
  assert.equal((await sentCloses()) - before, 0);
});

test("a right-click, a drag past the click slop, a drag that strays and comes back, or a cancelled press leaves the Peek open", () => {
  const { w, a, shown } = windowWithTwoPeeks();
  click(w, AT, 2);
  click(w, { x: AT.x, y: AT.y + OUTSIDE_CLICK_SLOP + 1 });
  click(w, AT, 0, () => movePeekOutsidePress(w, { x: AT.x, y: AT.y + 60 }));
  startPeekOutsidePress(w, AT, 0);
  cancelPeekOutsidePress(w);
  endPeekOutsidePress(w, AT);
  assert.equal(S().peeks[a]?.tabId, shown);
  click(w, { x: AT.x + OUTSIDE_CLICK_SLOP, y: AT.y });
  assert.equal(S().peeks[a], undefined, "a click that moved within the slop still closes it");
});

test("a click on another tab whose switch lands later (a pinned page handed over from another window, a profile dot) keeps the Peek", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentCloses();
  const { w, a, shown } = windowWithTwoPeeks();
  click(w, AT, 0, () => notePressSwitchesShownPage(w));
  assert.equal(S().peeks[a]?.tabId, shown, "the store still shows the same Peek, but the press asked for another page");
  assert.equal((await sentCloses()) - before, 0);
  click(w);
  assert.equal(S().peeks[a], undefined, "the switch mark lasts one press");
});

test("a switch mark left by a press outside the sidebar never blocks the next outside click", () => {
  const { w, a } = windowWithTwoPeeks();
  notePressSwitchesShownPage(w);
  click(w);
  assert.equal(S().peeks[a], undefined);
});

test("a press that started with no Peek shown doesn't close one that opened during it", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  let shown;
  click(w, AT, 0, () => (shown = S().openPeek(a, "https://peek.example/a")));
  assert.equal(S().peeks[a]?.tabId, shown);
});

test("a press on the sidebar's or the strip's empty space (a window drag region) closes the shown Peek, and does nothing without one", () => {
  const { w, a, b, other } = windowWithTwoPeeks();
  pressPeekOutsideOnDragRegion(w);
  assert.equal(S().peeks[a], undefined);
  pressPeekOutsideOnDragRegion(w);
  assert.equal(S().peeks[b]?.tabId, other, "a hidden tab's Peek is never the one closed");
});

test("while the dim is pinched out of sight, a press outside the card doesn't close it", () => {
  const { w, a, shown } = windowWithTwoPeeks();
  notePeekStageState(shown, "gesture", { chromeShown: false, scrimShown: false });
  click(w);
  pressPeekOutsideOnDragRegion(w);
  assert.equal(S().peeks[a]?.tabId, shown);
  forgetPeekStage(shown);
  click(w);
  assert.equal(S().peeks[a], undefined);
});
