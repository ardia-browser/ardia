import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NO_ROWS_SELECTED } from "../../state/history/historySelection.ts";
import { cursorRow, enteredCursor, isRowMenuKey, keepActivationKeys, LIST_KEYS, LIST_KEYS_WITH_ESCAPE, listCommand, menuRows, revealOffset, selectionAfter, startedCursor } from "./listCursor.ts";

const rows = ["a", "b", "c", "d"];
const picked = (s) => [...s.selected].sort();
const run = (s, ...keys) => keys.reduce((state, key) => selectionAfter(listCommand(key, state.selected.size > 0), rows, state), s);

test("the keys a list's cursor answers map to one command each", () => {
  assert.equal(listCommand({ key: "ArrowDown" }, false), "down");
  assert.equal(listCommand({ key: "ArrowUp" }, false), "up");
  assert.equal(listCommand({ key: "ArrowDown", shiftKey: true }, false), "extendDown");
  assert.equal(listCommand({ key: "ArrowUp", shiftKey: true }, false), "extendUp");
  assert.equal(listCommand({ key: " " }, false), "toggle");
  assert.equal(listCommand({ key: "Enter" }, false), "open");
  assert.equal(listCommand({ key: "ContextMenu" }, false), "menu");
  assert.equal(listCommand({ key: "F10", shiftKey: true }, false), "menu");
  assert.equal(listCommand({ key: "F10" }, false), null);
  assert.equal(listCommand({ key: "a", metaKey: true }, false), "all");
  assert.equal(listCommand({ key: "a" }, false), null);
  assert.equal(listCommand({ key: "Backspace" }, false), "remove");
  assert.equal(listCommand({ key: "Delete" }, false), "remove");
  assert.equal(listCommand({ key: "Escape" }, true), "clear");
  assert.equal(listCommand({ key: "Escape" }, false), null, "Escape with nothing selected is left for the window");
  assert.equal(isRowMenuKey({ key: "ContextMenu" }), true);
  for (const key of LIST_KEYS) assert.notEqual(listCommand(key, true), null, JSON.stringify(key));
  assert.deepEqual(LIST_KEYS_WITH_ESCAPE.slice(0, LIST_KEYS.length), LIST_KEYS);
  assert.deepEqual(LIST_KEYS_WITH_ESCAPE.at(-1), { key: "Escape" });
});

test("arrows walk the cursor without selecting, Space toggles the cursor row, Escape clears and ⌘A keeps the cursor", () => {
  let s = run(NO_ROWS_SELECTED, { key: "ArrowDown" }, { key: "ArrowDown" });
  assert.equal(cursorRow(rows, s), "b");
  assert.deepEqual(picked(s), []);
  s = run(s, { key: " " });
  assert.deepEqual(picked(s), ["b"]);
  s = run(s, { key: "ArrowDown", shiftKey: true });
  assert.deepEqual(picked(s), ["b", "c"]);
  s = run(s, { key: "Escape" });
  assert.deepEqual(picked(s), []);
  assert.equal(cursorRow(rows, s), "c");
  s = run(s, { key: "a", metaKey: true });
  assert.deepEqual(picked(s), rows);
  assert.equal(cursorRow(rows, s), "c");
  assert.equal(cursorRow(rows, run(NO_ROWS_SELECTED, { key: "ArrowUp" })), "d");
  assert.equal(selectionAfter("open", rows, s), s);
});

test("keyboard focus starts the cursor on the first row, keeps one a click already placed, and the search field's Down restarts it", () => {
  assert.equal(cursorRow(rows, startedCursor(rows, NO_ROWS_SELECTED)), "a");
  const clicked = { selected: new Set(["c"]), anchor: "c", cursor: "c" };
  assert.equal(startedCursor(rows, clicked), clicked);
  assert.equal(startedCursor([], NO_ROWS_SELECTED), NO_ROWS_SELECTED);
  assert.equal(cursorRow(rows, startedCursor(rows, { ...clicked, cursor: "gone" })), "a");
  assert.equal(cursorRow(rows, enteredCursor(rows, clicked)), "a");
  assert.deepEqual(picked(enteredCursor(rows, clicked)), ["c"]);
});

test("the menu acts on the whole selection only when the cursor row is part of it", () => {
  const s = { selected: new Set(["d", "b"]), anchor: "b", cursor: "b" };
  assert.deepEqual(menuRows(rows, s, "b"), ["b", "d"]);
  assert.deepEqual(menuRows(rows, s, "c"), ["c"]);
  assert.deepEqual(menuRows(rows, NO_ROWS_SELECTED, "a"), ["a"]);
});

test("Enter and Space on a focused row action stay with the action instead of also pressing its row", () => {
  const stopped = (key) => {
    let stop = false;
    keepActivationKeys({ nativeEvent: { key }, stopPropagation: () => (stop = true) });
    return stop;
  };
  assert.equal(stopped("Enter"), true);
  assert.equal(stopped(" "), true);
  assert.equal(stopped("ArrowDown"), false, "the list still hears the arrows");
  assert.equal(stopped("ContextMenu"), false);
  const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  assert.match(source("PageLayout.tsx"), /<View onKeyDown=\{keepActivationKeys\}><Button variant="icon" icon="ellipsis"/);
  assert.match(source("../downloads/Downloads.tsx"), /<View onKeyDown=\{keepActivationKeys\}>\s*<Button variant="icon"/);
});

test("the cursor row scrolls into view only when it is outside the viewport", () => {
  assert.equal(revealOffset(100, 36, 0, 300), null);
  assert.equal(revealOffset(100, 36, 120, 300), 100);
  assert.equal(revealOffset(400, 36, 0, 300), 136);
  assert.equal(revealOffset(-8, 36, 10, 300), 0);
});

test("History and Bookmarks drive their lists through the one shared cursor and reveal rule", () => {
  const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  for (const page of ["HistoryPage.tsx", "BookmarksPage.tsx"]) {
    const text = source(page);
    assert.match(text, /useListCursor\(/, page);
    assert.match(text, /<View \{\.\.\.listProps\}/, page);
    assert.match(text, /onArrow=\{enter\}/, page);
    assert.doesNotMatch(text, /onKeyDown=/, page);
  }
  assert.match(source("HistoryList.tsx"), /highlighted=\{cursor === row\.entry\.url\}/);
  assert.match(source("BookmarksPage.tsx"), /keyboardRow=\{cursor === id\}/);
  assert.match(source("HistoryRow.tsx"), /useRowControls\(entry\.url, highlighted\)/);
  assert.match(source("BookmarkRow.tsx"), /useRowControls\(id, keyboardRow\)/);
  for (const row of ["HistoryRow.tsx", "BookmarkRow.tsx"]) assert.match(source(row), /<Pressable\s+focusable=\{false\}/, row);
});
