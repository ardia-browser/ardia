import assert from "node:assert/strict";
import { test } from "node:test";
const { canInsertPane, insertPane, movePaneTo, normalized, paneBoxes, paneNeighbor, splitTabIds, swappedPanes, withoutPanes } = await import("./layout.ts");
const { splitGeometry } = await import("../../components/window/geometry.ts");

const pane = (tabId, size) => ({ size, tabId });
const stack = (size, a, b, stackSizes = [0.5, 0.5]) => ({ size, stack: [a, b], stackSizes });
const split = (orientation, ...slots) => ({ id: "s", windowId: "w", orientation, slots });
const shape = (v) => `${v.orientation}|${v.slots.map((slot) => ("stack" in slot ? slot.stack.join("+") : slot.tabId)).join(",")}`;

const row = split("horizontal", pane("A", 0.5), stack(0.5, "B", "C"));
const column = split("vertical", pane("A", 0.5), stack(0.5, "B", "C"));

test("pane boxes slice the unit square the way the window's split geometry does", () => {
  for (const v of [row, column, split("horizontal", pane("A", 0.25), pane("B", 0.35), pane("C", 0.4)), split("vertical", stack(0.4, "A", "B", [0.3, 0.7]), pane("C", 0.6))]) {
    const boxes = paneBoxes(v);
    const { panes } = splitGeometry(v, 1000, 1000, 0);
    assert.deepEqual(Object.keys(boxes).sort(), splitTabIds(v).slice().sort());
    for (const id of splitTabIds(v)) {
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(boxes[id][key] * 1000 - panes[id][key]) <= 1, `${shape(v)} ${id}.${key}`);
    }
  }
  assert.deepEqual(paneBoxes(row).C, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
});

test("a neighbor lies wholly in the direction and overlaps across it; ties go to the top or left pane", () => {
  assert.equal(paneNeighbor(row, "A", "right"), "B");
  assert.equal(paneNeighbor(row, "C", "left"), "A");
  assert.equal(paneNeighbor(row, "B", "left"), "A");
  assert.equal(paneNeighbor(row, "B", "down"), "C");
  assert.equal(paneNeighbor(row, "C", "up"), "B");
  assert.equal(paneNeighbor(row, "A", "left"), null);
  assert.equal(paneNeighbor(row, "A", "up"), null);
  assert.equal(paneNeighbor(row, "B", "right"), null);
  assert.equal(paneNeighbor(column, "A", "down"), "B");
  assert.equal(paneNeighbor(column, "C", "up"), "A");
  assert.equal(paneNeighbor(column, "B", "right"), "C");
  assert.equal(paneNeighbor(column, "A", "right"), null);
  const three = split("horizontal", pane("A", 0.3), pane("B", 0.3), pane("C", 0.4));
  assert.equal(paneNeighbor(three, "A", "right"), "B");
  assert.equal(paneNeighbor(three, "C", "left"), "B");
  assert.equal(paneNeighbor(three, "B", "up"), null);
  const lopsided = split("horizontal", stack(0.5, "A", "B", [0.3, 0.7]), pane("C", 0.5));
  assert.equal(paneNeighbor(lopsided, "C", "left"), "B", "most overlap wins");
  assert.equal(paneNeighbor(row, "Z", "left"), null);
});

test("swapping two panes trades their tabs and keeps every size", () => {
  const v = split("horizontal", pane("A", 0.3), stack(0.7, "B", "C", [0.2, 0.8]));
  const swapped = swappedPanes(v, "A", "C");
  assert.deepEqual(swapped.slots, [pane("C", 0.3), stack(0.7, "B", "A", [0.2, 0.8])]);
  assert.equal(swapped.id, "s");
  assert.equal(swappedPanes(v, "A", "A"), null);
  assert.equal(swappedPanes(v, "A", "Z"), null);
});

test("inserting follows the split's axis, stacks across it, and refuses a full split or a stack that can't grow", () => {
  const fresh = insertPane(undefined, "A", "B", "top", "w");
  assert.equal(fresh.orientation, "vertical");
  assert.deepEqual(splitTabIds(fresh), ["B", "A"]);
  const two = split("horizontal", pane("A", 0.4), pane("B", 0.6));
  assert.equal(shape(insertPane(two, "A", "C", "left", "w")), "horizontal|C,A,B");
  assert.equal(shape(insertPane(two, "B", "C", "bottom", "w")), "horizontal|A,B+C");
  assert.equal(insertPane(row, "A", "D", "right", "w"), null);
  const lone = split("horizontal", stack(1, "A", "B"));
  assert.equal(shape(insertPane(lone, "B", "C", "bottom", "w")), "vertical|A,B,C");
  assert.equal(canInsertPane(undefined, "A", "right"), true);
  assert.equal(canInsertPane(two, "A", "bottom"), true);
  assert.equal(canInsertPane(row, "A", "right"), false);
  assert.equal(canInsertPane(split("horizontal", pane("A", 0.5), pane("B", 0.5)), "Z", "right"), false);
  assert.equal(canInsertPane({ ...row, slots: [pane("A", 0.5), stack(0.5, "B", "C")] }, "B", "bottom"), false);
});

test("a split left with one stack becomes the flipped split of its two panes, with the stack's sizes", () => {
  const lone = split("horizontal", stack(1, "B", "C", [0.3, 0.7]));
  assert.deepEqual(normalized(lone), split("vertical", pane("B", 0.3), pane("C", 0.7)));
  const rest = withoutPanes(split("horizontal", pane("A", 0.4), stack(0.6, "B", "C", [0.3, 0.7])), new Set(["A"]));
  assert.deepEqual(rest, split("vertical", pane("B", 0.3), pane("C", 0.7)));
  assert.equal(normalized(row), row);
});

test("a pure reorder along the axis keeps each slot's size; a move across it evens out", () => {
  const two = split("horizontal", pane("A", 0.35), pane("B", 0.65));
  assert.deepEqual(movePaneTo(two, "A", "B", "right").slots, [pane("B", 0.65), pane("A", 0.35)]);
  const three = split("vertical", pane("A", 0.2), pane("B", 0.3), pane("C", 0.5));
  assert.deepEqual(movePaneTo(three, "A", "C", "bottom").slots, [pane("B", 0.3), pane("C", 0.5), pane("A", 0.2)]);
  const across = movePaneTo(two, "B", "A", "bottom");
  assert.equal(shape(across), "vertical|A,B");
  assert.deepEqual(across.slots.map((slot) => slot.size), [0.5, 0.5]);
  assert.equal(across.id, "s");
});

test("re-docking reshapes two and three panes and never leaves a one-slot split", () => {
  assert.equal(shape(movePaneTo(row, "A", "B", "top")), "vertical|A,B,C");
  assert.equal(shape(movePaneTo(row, "C", "A", "left")), "horizontal|C,A,B");
  assert.equal(shape(movePaneTo(row, "C", "A", "bottom")), "horizontal|A+C,B");
  assert.equal(shape(movePaneTo(row, "A", "C", "right")), "vertical|B,C+A");
  assert.equal(shape(movePaneTo(column, "B", "A", "right")), "vertical|A+B,C");
  const three = split("horizontal", pane("A", 0.3), pane("B", 0.3), pane("C", 0.4));
  assert.equal(shape(movePaneTo(three, "A", "B", "bottom")), "horizontal|B+A,C");
  for (const v of [row, column, three]) {
    for (const tabId of splitTabIds(v)) {
      for (const anchorId of splitTabIds(v)) {
        if (tabId === anchorId) continue;
        for (const side of ["left", "right", "top", "bottom"]) {
          const moved = movePaneTo(v, tabId, anchorId, side);
          assert.ok(moved, `${shape(v)} ${tabId} ${side} of ${anchorId}`);
          assert.ok(moved.slots.length >= 2);
          assert.deepEqual(splitTabIds(moved).slice().sort(), splitTabIds(v).slice().sort());
          assert.ok(Math.abs(moved.slots.reduce((sum, slot) => sum + slot.size, 0) - 1) < 1e-9);
          const boxes = paneBoxes(moved);
          const ends = { left: "x", top: "y" };
          if (side === "left" || side === "top") assert.ok(boxes[tabId][ends[side]] < boxes[anchorId][ends[side]]);
          else if (side === "right") assert.ok(boxes[tabId].x > boxes[anchorId].x);
          else assert.ok(boxes[tabId].y > boxes[anchorId].y);
        }
      }
    }
  }
});

test("a move to where the pane already is returns the same split; a bad move returns null", () => {
  const two = split("horizontal", pane("A", 0.35), pane("B", 0.65));
  assert.equal(movePaneTo(two, "B", "A", "right"), two);
  assert.equal(movePaneTo(two, "A", "B", "left"), two);
  assert.equal(movePaneTo(row, "C", "B", "bottom"), row);
  assert.equal(movePaneTo(row, "B", "C", "top"), row);
  assert.equal(movePaneTo(two, "A", "A", "left"), null);
  assert.equal(movePaneTo(two, "A", "Z", "left"), null);
  assert.equal(movePaneTo(two, "Z", "A", "left"), null);
});

test("a saved split of one stacked slot is read as two plain panes, and a move that changes nothing keeps its sizes", () => {
  const lone = { id: "s", windowId: "w", orientation: "horizontal", slots: [{ size: 1, stack: ["B", "C"], stackSizes: [0.3, 0.7] }] };
  assert.equal(movePaneTo(lone, "C", "B", "bottom"), lone);
  const moved = movePaneTo(lone, "B", "C", "bottom");
  assert.equal(moved.orientation, "vertical");
  assert.deepEqual(splitTabIds(moved), ["C", "B"]);
  assert.deepEqual(moved.slots.map((slot) => slot.size), [0.7, 0.3]);
});
