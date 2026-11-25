import assert from "node:assert/strict";
import { test } from "node:test";
const { dragGesture, leavesClickSlop } = await import("./dragGesture.ts");
const { TAB_CLICK_SLOP } = await import("../../state/sidebar/heldTabPress.ts");

function recorder(draggable = true) {
  const calls = [];
  const gesture = dragGesture(draggable, {
    begin: (x, y) => calls.push(["begin", x, y]),
    move: (x, y) => calls.push(["move", x, y]),
    end: (commit) => calls.push(["end", commit]),
  });
  return { calls, gesture };
}

test("a press that drifts no farther than a click allows stays a click: no drag starts, so the row and its group never hide", () => {
  const { gesture } = recorder();
  for (let d = 0; d <= TAB_CLICK_SLOP; d++) {
    assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: d, dy: 0 }), false, `${d} pt across`);
    assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: 0, dy: -d }), false, `${d} pt up`);
  }
  assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: 7, dy: 7 }), false, "7 pt diagonally is under 10 pt of travel");
});

test("past the click slop the drag takes the press, starts where the pointer is, follows it and ends on release", () => {
  const { calls, gesture } = recorder();
  assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: TAB_CLICK_SLOP + 1, dy: 0 }), true);
  assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: 8, dy: 8 }), true);
  assert.equal(gesture.onPanResponderTerminationRequest(), false);
  gesture.onPanResponderGrant({}, { x0: 40, y0: 120 });
  gesture.onPanResponderMove({}, { moveX: 44, moveY: 150 });
  gesture.onPanResponderRelease();
  gesture.onPanResponderGrant({}, { x0: 40, y0: 120 });
  gesture.onPanResponderTerminate();
  assert.deepEqual(calls, [["begin", 40, 120], ["move", 44, 150], ["end", true], ["begin", 40, 120], ["end", false]]);
});

test("a tail slot never starts a drag, however far the pointer goes", () => {
  const { gesture } = recorder(false);
  assert.equal(gesture.onMoveShouldSetPanResponder({}, { dx: 0, dy: 200 }), false);
});

test("the click slop is the one distance: under it a press is a click, over it a drag", () => {
  assert.equal(leavesClickSlop({ dx: TAB_CLICK_SLOP, dy: 0 }), false);
  assert.equal(leavesClickSlop({ dx: 6, dy: 8 }), false);
  assert.equal(leavesClickSlop({ dx: 6, dy: 8.1 }), true);
});
