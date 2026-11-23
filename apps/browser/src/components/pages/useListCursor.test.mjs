import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { LIST_KEYS, LIST_KEYS_WITH_ESCAPE } from "./listCursor.ts";
import { useListCursor } from "./useListCursor.ts";

const listView = { name: "list" };
const rowButton = { name: "More actions" };

function cursorList(t, rows = ["a", "b", "c"]) {
  const calls = [];
  const mounted = mount((keys) => useListCursor(keys, { open: (row) => calls.push(["open", row]), menu: (row) => calls.push(["menu", row]), remove: () => calls.push(["remove"]) }), { props: rows });
  t.after(() => mounted.unmount());
  const press = (key, patch = {}, target = listView) => {
    let prevented = false;
    mounted.value.listProps.onKeyDown({ target, currentTarget: listView, nativeEvent: { key, ...patch }, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { calls, press, get state() { return mounted.value; }, focus: (target = listView) => mounted.value.listProps.onFocus({ target, currentTarget: listView }) };
}

test("the list is one focusable stop that takes focus without a ring", (t) => {
  const { state } = cursorList(t);
  assert.equal(state.listProps.focusable, true);
  assert.equal(state.listProps.enableFocusRing, false);
  assert.equal(state.listProps.keyDownEvents, LIST_KEYS);
});

test("keyboard focus puts the cursor on the first row, and Enter, the menu key and Delete act on it", (t) => {
  const list = cursorList(t);
  list.focus();
  assert.equal(list.state.cursor, "a");
  assert.equal(list.press("ArrowDown"), true);
  assert.equal(list.state.cursor, "b");
  list.press("Enter");
  list.press("ContextMenu");
  list.press("F10", { shiftKey: true });
  assert.equal(list.press("Delete"), true);
  assert.deepEqual(list.calls, [["open", "b"], ["menu", "b"], ["menu", "b"]], "Delete with nothing selected removes nothing");
  list.press(" ");
  assert.deepEqual([...list.state.selection.selected], ["b"]);
  assert.equal(list.state.listProps.keyDownEvents, LIST_KEYS_WITH_ESCAPE);
  list.press("Backspace");
  assert.deepEqual(list.calls.at(-1), ["remove"]);
  list.press("Escape");
  assert.equal(list.state.selection.selected.size, 0);
  assert.equal(list.press("Escape"), false, "a second Escape goes on to the window");
});

test("keys and focus that bubble up from a focused button inside a row leave the cursor alone", (t) => {
  const list = cursorList(t);
  list.focus(rowButton);
  assert.equal(list.state.cursor, null);
  list.focus();
  assert.equal(list.press(" ", {}, rowButton), false);
  assert.equal(list.press("Enter", {}, rowButton), false);
  assert.equal(list.press("ArrowDown", {}, rowButton), false);
  assert.equal(list.state.cursor, "a");
  assert.equal(list.state.selection.selected.size, 0);
  assert.deepEqual(list.calls, []);
});

test("rows that leave the list take the cursor with them", (t) => {
  const calls = [];
  const mounted = mount((keys) => useListCursor(keys, { open: () => {}, menu: () => {}, remove: () => calls.push("remove") }), { props: ["a", "b"] });
  t.after(() => mounted.unmount());
  mounted.value.listProps.onFocus({ target: listView, currentTarget: listView });
  assert.equal(mounted.value.cursor, "a");
  mounted.rerender(["b"]);
  assert.equal(mounted.value.cursor, null);
  mounted.value.listProps.onKeyDown({ target: listView, currentTarget: listView, nativeEvent: { key: "Enter" }, preventDefault() {} });
  assert.deepEqual(calls, []);
});
