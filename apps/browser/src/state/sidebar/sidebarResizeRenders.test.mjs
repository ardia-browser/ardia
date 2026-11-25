import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { resizeGesture } = await import("../../components/sidebar/resizeDrag.ts");
const sidebarUi = await import("./sidebarUi.ts");
const { useSidebarWidth } = await import("./hooks.ts");
const { useBrowser } = await import("../browser/store.ts");

const WINDOW = "w1";
const SAVED = 240;
const MOVES = 120;
const pointerAt = (i) => (i <= MOVES / 2 ? i * 2 : (MOVES - i) * 2);

function startDrag() {
  const gesture = resizeGesture({
    current: {
      min: 160,
      max: 400,
      direction: 1,
      saved: () => SAVED,
      onLive: (width) => sidebarUi.setLiveSidebarWidth(WINDOW, width),
      onCommit: () => {},
    },
  });
  gesture.onPanResponderGrant({});
  return {
    move: (i) => gesture.onPanResponderMove({}, { dx: pointerAt(i) }),
    release: () => gesture.onPanResponderRelease({}, { dx: 0 }),
  };
}

test("a sidebar resize writes to the sidebar UI store at the grab and the release, not on every pointer move", () => {
  useBrowser.getState().hydrate({});
  let notified = 0;
  const stop = sidebarUi.useSidebarUi.subscribe(() => notified++);
  try {
    const drag = startDrag();
    for (let i = 1; i <= MOVES; i++) drag.move(i);
    const duringMoves = notified;
    drag.release();
    assert.ok(duringMoves <= 1, `${duringMoves} store notifications for ${MOVES} pointer moves`);
    assert.ok(notified <= 2, `${notified} store notifications for one whole resize`);
  } finally {
    stop();
  }
});

test("a component that reads the sidebar's width does not render again for every pointer move", () => {
  useBrowser.getState().hydrate({});
  const reader = mount(() => useSidebarWidth(WINDOW));
  try {
    const before = reader.renders;
    const drag = startDrag();
    for (let i = 1; i <= MOVES; i++) {
      drag.move(i);
      void reader.value;
    }
    drag.release();
    const rendered = reader.renders - before;
    assert.ok(rendered <= 2, `${rendered} renders for ${MOVES} pointer moves`);
  } finally {
    reader.unmount();
  }
});

test("the pointer's width is held in a per-window animated value, and the resizing flag is up only while the edge is held", () => {
  useBrowser.getState().hydrate({});
  const drag = startDrag();
  assert.equal(WINDOW in sidebarUi.sidebarUi().resizing, true);
  const live = sidebarUi.liveSidebarWidth(WINDOW);
  for (let i = 1; i <= MOVES; i++) {
    drag.move(i);
    assert.equal(live.__getValue(), SAVED + pointerAt(i));
  }
  assert.equal(sidebarUi.liveSidebarWidth(WINDOW), live);
  assert.notEqual(sidebarUi.liveSidebarWidth("w2"), live);
  drag.release();
  assert.equal(WINDOW in sidebarUi.sidebarUi().resizing, false);
});
