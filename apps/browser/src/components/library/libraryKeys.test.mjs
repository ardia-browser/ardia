import assert from "node:assert/strict";
import { test } from "node:test";

const { plainKey, SEARCH_KEYS, searchKeyAction } = await import("./libraryKeys.ts");

test("Escape in the search field clears or closes, and plain Down or Return moves into the list", () => {
  assert.equal(searchKeyAction({ key: "Escape" }), "escape");
  assert.equal(searchKeyAction({ key: "ArrowDown" }), "enterList");
  assert.equal(searchKeyAction({ key: "Enter", metaKey: false, shiftKey: false }), "enterList");
});

test("text editing keys the field reports stay in the field", () => {
  const editing = [
    { key: "a", metaKey: true },
    { key: "ArrowLeft", metaKey: true },
    { key: "ArrowRight", metaKey: true },
    { key: "ArrowLeft", altKey: true },
    { key: "ArrowRight", shiftKey: true, altKey: true },
    { key: "ArrowDown", shiftKey: true },
    { key: "ArrowDown", metaKey: true },
    { key: "Backspace", metaKey: true },
    { key: "a", ctrlKey: true },
    { key: "e", ctrlKey: true },
    { key: "x" },
  ];
  for (const press of editing) assert.equal(searchKeyAction(press), null, JSON.stringify(press));
});

test("every key the field asks for does something", () => {
  for (const k of SEARCH_KEYS) assert.equal(searchKeyAction(k) !== null, true, k.key);
});

test("a key held with a modifier is not a plain key", () => {
  assert.equal(plainKey({ key: "ArrowUp" }), "ArrowUp");
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) assert.equal(plainKey({ key: "ArrowUp", [modifier]: true }), null, modifier);
});
