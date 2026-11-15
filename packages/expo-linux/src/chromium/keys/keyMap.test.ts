import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { __ARDIA_VERSION__: "1.0.0", __ARDIA_BUILD__: "1", __ARDIA_NATIVE_API_VERSION__: 64, __ARDIA_DEBUG__: false, __ARDIA_UPDATE_REPOSITORY__: "x/y" });

const { menuStore } = await import("./store");
const { Modifier } = await import("./combos");
const { buildKeyMap, pressesFor, QUIT, SWITCHER_KEY, DRAG_ESCAPE } = await import("./keyMap");

const idle = { recording: false, switcherHeld: 0, escapeCaptured: false, textInputFocused: false, undoReopensClosedTab: false, reopenClosedTabEnabled: true };
const usable = (entry: (typeof menuStore.entries)[number]) => menuStore.entryReachable(entry) && menuStore.entryEnabled(entry);
const find = (map: ReturnType<typeof buildKeyMap>, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  map.find((entry) => entry.code === code && entry.ctrl === !!mods.ctrl && entry.shift === !!mods.shift && entry.alt === !!mods.alt);

test("the default table maps Ctrl+L and Alt+D to the command bar and Ctrl+T to a new tab", () => {
  menuStore.update({});
  const map = buildKeyMap(menuStore.entries, usable, idle);
  assert.equal(find(map, "KeyL", { ctrl: true })?.command, "focusCommandBar");
  assert.equal(find(map, "KeyD", { alt: true })?.command, "focusCommandBar");
  assert.equal(find(map, "KeyT", { ctrl: true })?.command, "newTab");
  assert.equal(find(map, "KeyT", { ctrl: true })?.pageFirst, false);
  const tab = find(map, "Digit1", { ctrl: true });
  assert.equal(tab?.command, "selectTab");
  assert.equal(tab?.arg, "1");
  assert.equal(find(map, "KeyQ", { ctrl: true })?.command, QUIT);
});

test("native actions keep their row id, and bare keys go to the page first", () => {
  menuStore.update({});
  const map = buildKeyMap(menuStore.entries, usable, idle);
  assert.equal(find(map, "KeyW", { ctrl: true, shift: true })?.command, "std:closeWindow:");
  const fullScreen = find(map, "F11");
  assert.equal(fullScreen?.command, "std:toggleFullScreen:");
  assert.equal(fullScreen?.pageFirst, true);
  assert.ok(!map.some((entry) => entry.command.startsWith("std:") && !["std:closeWindow:", "std:toggleFullScreen:"].includes(entry.command)));
});

test("a disabled command and a remapped one change the map", () => {
  menuStore.update({ disabled: ["newTab"], shortcuts: { focusCommandBar: [["k", "control"]] } });
  const map = buildKeyMap(menuStore.entries, usable, idle);
  assert.equal(find(map, "KeyT", { ctrl: true }), undefined);
  assert.equal(find(map, "KeyL", { ctrl: true }), undefined);
  assert.equal(find(map, "KeyK", { ctrl: true })?.command, "focusCommandBar");
  menuStore.update({});
});

test("shifted symbols map to the US key with Shift, digits to the number row and the keypad", () => {
  assert.deepEqual(pressesFor({ key: "{", modifiers: Modifier.Control }), [{ code: "BracketLeft", modifiers: Modifier.Control | Modifier.Shift }]);
  const plus = pressesFor({ key: "+", modifiers: Modifier.Control }).map((press) => press.code).sort();
  assert.deepEqual(plus, ["Equal", "NumpadAdd"]);
  const two = pressesFor({ key: "2", modifiers: Modifier.Control }).map((press) => press.code).sort();
  assert.deepEqual(two, ["Digit2", "Numpad2"]);
});

test("recording empties the map, the switcher and a drag capture their keys", () => {
  menuStore.update({});
  assert.deepEqual(buildKeyMap(menuStore.entries, usable, { ...idle, recording: true }), []);
  const switcher = buildKeyMap(menuStore.entries, usable, { ...idle, switcherHeld: Modifier.Control });
  assert.equal(find(switcher, "Escape", { ctrl: true })?.command, SWITCHER_KEY);
  assert.equal(find(switcher, "ArrowRight")?.arg, "next");
  const dragging = buildKeyMap(menuStore.entries, usable, { ...idle, escapeCaptured: true });
  assert.equal(find(dragging, "Escape")?.command, DRAG_ESCAPE);
  assert.equal(find(dragging, "Escape")?.pageFirst, false);
});

test("undo reopens a closed tab only outside an app text field", () => {
  menuStore.update({ undoReopensClosedTab: true });
  const map = buildKeyMap(menuStore.entries, usable, { ...idle, undoReopensClosedTab: true });
  assert.equal(find(map, "KeyZ", { ctrl: true })?.command, "reopenClosedTab");
  const typing = buildKeyMap(menuStore.entries, usable, { ...idle, undoReopensClosedTab: true, textInputFocused: true });
  assert.equal(find(typing, "KeyZ", { ctrl: true }), undefined);
  menuStore.update({});
});
