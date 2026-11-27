import assert from "node:assert/strict";
import { test } from "node:test";

const { FRAME_UNDER_OLD_PEEK_GAP, noteSidebarPeekFrame, takeDockCounts } = await import("./dockCounts.ts");

test("a peek on a frame thinner than the old 4 pt peek gap is counted, and the count resets once taken", () => {
  takeDockCounts();
  for (const inset of [0, 1, 2, 3, FRAME_UNDER_OLD_PEEK_GAP, 9, 12]) noteSidebarPeekFrame(inset);
  assert.equal(takeDockCounts().sidebar_thin_frame_peeks, 4);
  assert.equal(takeDockCounts().sidebar_thin_frame_peeks, 0);
});

test("a peek whose slide passed its final width counts only under the consent period it started in, and the count resets once taken", async () => {
  const { noteSidebarPeekPastTarget } = await import("./dockCounts.ts");
  const { consentToken, setConsentPeriod } = await import("./consentPeriod.ts");
  takeDockCounts();
  setConsentPeriod(true, "peek-on");
  const started = consentToken();
  noteSidebarPeekPastTarget(started);
  noteSidebarPeekPastTarget(null);
  setConsentPeriod(true, "peek-next");
  noteSidebarPeekPastTarget(started);
  setConsentPeriod(false, null);
  assert.equal(takeDockCounts().sidebar_peeks_past_target, 1);
  assert.equal(takeDockCounts().sidebar_peeks_past_target, 0);
});

async function overlayPeek(t) {
  const { mount } = await import("../../test-hooks.mjs");
  const { AppState } = await import("react-native");
  const { usePeek } = await import("../../components/window/usePeek.ts");
  const { consentToken, setConsentPeriod } = await import("./consentPeriod.ts");
  const opens = [];
  const view = mount(() => usePeek(true, false, () => false, () => {}, (bounce) => opens.push(bounce)));
  t.after(() => {
    view.unmount();
    AppState.currentState = "active";
    setConsentPeriod(false, null);
  });
  takeDockCounts();
  return { peek: () => view.value, opens, AppState, consentToken, setConsentPeriod };
}

test("a peek opened through another app's screen sharing border is counted once, under consent, and a plain reveal or a reveal while it is out is not", async (t) => {
  const { peek, opens, setConsentPeriod } = await overlayPeek(t);
  setConsentPeriod(true, "overlay-on");
  peek().show();
  peek().hide(true);
  peek().reset();
  peek().showThroughOverlay();
  peek().showThroughOverlay();
  assert.deepEqual(opens, [false, false]);
  assert.equal(takeDockCounts().sidebar_edge_reveals_through_overlay, 1);
  peek().reset();
  setConsentPeriod(false, null);
  peek().showThroughOverlay();
  assert.equal(takeDockCounts().sidebar_edge_reveals_through_overlay, 0, "nothing is counted with sharing off");
});

test("an overlay reveal waiting for Ardia to come to the front is counted when it opens, and one dropped while waiting never leaks into a later reveal", async (t) => {
  const { peek, opens, AppState, setConsentPeriod } = await overlayPeek(t);
  setConsentPeriod(true, "overlay-wait");
  AppState.currentState = "inactive";
  peek().showThroughOverlay();
  assert.deepEqual(opens, [], "held until the app is in front");
  AppState.currentState = "active";
  peek().show();
  assert.equal(takeDockCounts().sidebar_edge_reveals_through_overlay, 1, "the focus that opens it keeps where it came from");
  peek().reset();
  AppState.currentState = "inactive";
  peek().showThroughOverlay();
  peek().cancelPending(false);
  AppState.currentState = "active";
  peek().show();
  assert.deepEqual(opens.length, 2);
  assert.equal(takeDockCounts().sidebar_edge_reveals_through_overlay, 0, "an empty-window reveal after the pointer left isn't an overlay reveal");
});

test("an overlay reveal counts only under the consent period it was taken in", async () => {
  const { noteSidebarEdgeRevealThroughOverlay } = await import("./dockCounts.ts");
  const { consentToken, setConsentPeriod } = await import("./consentPeriod.ts");
  takeDockCounts();
  setConsentPeriod(true, "overlay-first");
  const first = consentToken();
  setConsentPeriod(true, "overlay-second");
  noteSidebarEdgeRevealThroughOverlay(first);
  noteSidebarEdgeRevealThroughOverlay(null);
  noteSidebarEdgeRevealThroughOverlay(consentToken());
  setConsentPeriod(false, null);
  assert.equal(takeDockCounts().sidebar_edge_reveals_through_overlay, 1);
});
