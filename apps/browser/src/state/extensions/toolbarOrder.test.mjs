import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useExtensions } = await import("./store.ts");
const { moveToolbarExtension } = await import("./actions.ts");
const { dropIndex, makeRoomShift, movedToolbarOrder, toolbarOrder } = await import("./toolbarOrder.ts");

const ext = (id, pinnedIndex, more = {}) => ({ id, name: id, enabled: true, pinned: pinnedIndex !== undefined, pinnedIndex, hasAction: true, incognito: false, ...more });

test("the toolbar shows pinned extensions in Chrome's order, newly pinned ones last", () => {
  const list = [ext("a", 2), ext("b", 0), ext("c"), ext("d", undefined, { pinned: true }), ext("e", 1)];
  assert.deepEqual(toolbarOrder(list).map((x) => x.id), ["b", "e", "a", "d"]);
});

test("a drop lands on the nearest slot and stays inside the row", () => {
  assert.equal(dropIndex(0, 40, 30, 4), 1);
  assert.equal(dropIndex(0, 14, 30, 4), 0);
  assert.equal(dropIndex(3, -500, 30, 4), 0);
  assert.equal(dropIndex(1, 500, 30, 4), 3);
});

test("the buttons between the grab and the drop slide aside by one slot", () => {
  const drag = { id: "a", from: 0, dx: 65 };
  assert.deepEqual([0, 1, 2, 3].map((i) => makeRoomShift(i, drag, 30, 4)), [0, -30, -30, 0]);
  const back = { id: "d", from: 3, dx: -61 };
  assert.deepEqual([0, 1, 2, 3].map((i) => makeRoomShift(i, back, 30, 4)), [0, 30, 30, 0]);
  assert.deepEqual([0, 1].map((i) => makeRoomShift(i, null, 30, 2)), [0, 0]);
});

test("a move asks Chrome for the index of the button it lands on, which skips hidden pinned actions", () => {
  const shown = [ext("a", 0), ext("b", 2), ext("c", 3)];
  const right = movedToolbarOrder(shown, "a", 2);
  assert.equal(right.pinnedIndex, 3);
  assert.deepEqual([...right.slots], [["b", 0], ["c", 2], ["a", 3]]);
  const left = movedToolbarOrder(shown, "c", 0);
  assert.equal(left.pinnedIndex, 0);
  assert.deepEqual([...left.slots], [["c", 0], ["a", 2], ["b", 3]]);
  assert.equal(movedToolbarOrder(shown, "a", 0), null);
  assert.equal(movedToolbarOrder([ext("a", 0), ext("n", undefined, { pinned: true })], "a", 1), null);
});

test("dropping reorders the toolbar at once and tells Chrome which extension moved", async () => {
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({ url: "a.com" });
  useExtensions.setState({ lists: { "": [ext("a", 0), ext("b", 1), ext("c", 2)] } });
  const asked = [];
  native.extensionAnswers.change = async (what, id) => void asked.push([what, id]);
  await moveToolbarExtension(w, "a", 2);
  assert.deepEqual(toolbarOrder(useExtensions.getState().lists[""]).map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(asked, [["configure", "a"]]);
});
