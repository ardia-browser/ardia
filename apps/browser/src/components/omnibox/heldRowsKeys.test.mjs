import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
const { barKeyDown } = await import("./omniboxKeys.ts");
const { followedRow, heldIndex } = await import("./heldSelection.ts");

const row = (url, kind = "page") => ({ kind, url, title: url });
const typedRow = { kind: "search", url: "search:exa", title: "exa" };
const github = row("https://github.com/");
const example = row("https://example.com/");
const late = row("https://late.example/");

const press = (key, context) => barKeyDown({ nativeEvent: { key } }, context);

function bar({ items, selectedIndex = 0, rowsHeld }) {
  const dispatched = [];
  const released = [];
  const order = [];
  const context = {
    bar: { scope: null, typed: "exa", scopeFrom: null, dispatch: (e) => (dispatched.push(e), order.push("select")) },
    hero: false,
    shownCompletion: "",
    input: "exa",
    items,
    selectedIndex,
    previewing: false,
    current: items[selectedIndex],
    tabScope: null,
    cancelBang() {},
    reset() {},
    removeRow() {},
    rowsHeld,
    releaseRows: (index) => (released.push(index), order.push("release")),
    forceSearch() {},
    go() {},
    choose() {},
  };
  return { context, dispatched, released, order };
}

test("the first ↓ while late rows wait under the pointer shows them and moves the selection in the same press", () => {
  const { context, dispatched, released, order } = bar({ items: [typedRow, github, example], rowsHeld: true });
  press("ArrowDown", context);
  assert.deepEqual(released, [1], "the waiting rows are shown, following the row the press moved to");
  assert.deepEqual(dispatched, [{ kind: "selected", index: 1 }], "and the selection moves at once, no second press");
  assert.deepEqual(order, ["select", "release"], "the row is selected among the rows shown before they are swapped, so an unbatched release can't put the selection on a row that arrived late");
});

test("↑, PageUp and PageDown also move on the press that shows the waiting rows", () => {
  for (const [key, index] of [["ArrowUp", 2], ["PageUp", 0], ["PageDown", 2]]) {
    const { context, dispatched, released } = bar({ items: [typedRow, github, example], rowsHeld: true });
    press(key, context);
    assert.deepEqual(released, [index], key);
    assert.deepEqual(dispatched, [{ kind: "selected", index }], key);
  }
});

test("with nothing waiting, ↓ only moves the selection", () => {
  const { context, dispatched, released } = bar({ items: [typedRow, github, example], rowsHeld: false });
  press("ArrowDown", context);
  assert.deepEqual(released, []);
  assert.deepEqual(dispatched, [{ kind: "selected", index: 1 }]);
});

test("the row the press moved to stays selected when the waiting rows arrive above it", () => {
  const shown = [typedRow, github, example];
  const held = followedRow({ items: shown, typed: "exa", scope: null, key: null }, 1);
  const arrived = [typedRow, late, github, example];
  assert.equal(heldIndex(held, arrived, "exa", null, 1), 2, "the selection follows github.com to its new place");
});

test("a press to the first row follows the first row, which is always the typed text", () => {
  const held = followedRow({ items: [typedRow, github], typed: "exa", scope: null, key: null }, 0);
  assert.equal(heldIndex(held, [typedRow, late, github], "exa", null, 0), 0);
});
