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

test("in the idle command bar, ↓ wrapping from the last open tab to the first keeps that tab when a late tab arrives above it", () => {
  const tab = (id) => ({ kind: "page", url: `https://${id}.example/`, title: id, tabId: id });
  const shown = [tab("a"), tab("b"), tab("c")];
  const { context, dispatched, released } = bar({ items: shown, selectedIndex: 2, rowsHeld: true });
  context.bar.typed = "";
  context.input = "";
  press("ArrowDown", context);
  assert.deepEqual(dispatched, [{ kind: "selected", index: 0 }]);
  assert.deepEqual(released, [0]);
  const held = followedRow({ items: shown, typed: "", scope: null, key: null }, 0);
  assert.equal(heldIndex(held, [tab("late"), ...shown], "", null, 0), 1, "the selection stays on tab a, not on the tab that arrived");
});

test("with text typed, the first row stays the first row, whatever arrives", () => {
  const tabRow = { kind: "page", url: "https://exa.example/", title: "exa", tabId: "t1" };
  const held = followedRow({ items: [tabRow, github], typed: "exa", scope: null, key: null }, 0);
  assert.equal(heldIndex(held, [late, tabRow, github], "exa", null, 0), 0);
});

test("in the sidebar bar's start list, the current page in the first row keeps its place the same way when nothing is typed", () => {
  const current = { kind: "page", url: "https://current.example/", title: "current" };
  const recent = { kind: "page", url: "https://recent.example/", title: "recent", visited: true };
  const held = followedRow({ items: [current, recent], typed: "", scope: null, key: null }, 0);
  assert.equal(heldIndex(held, [recent, current], "", null, 0), 1);
});

test("two open tabs on the same page are different rows, so the selection stays on the tab it moved to when the other sorts above it", () => {
  const a = { kind: "page", url: "https://same.example/", title: "same", tabId: "a" };
  const b = { kind: "page", url: "https://same.example/", title: "same", tabId: "b" };
  const other = { kind: "page", url: "https://other.example/", title: "other", tabId: "c" };
  const held = followedRow({ items: [other, a, b], typed: "", scope: null, key: null }, 2);
  assert.equal(heldIndex(held, [b, other, a], "", null, 2), 0, "tab b is followed to the top, not swapped for tab a at its old place");
});
