import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShortcut } from "../../shortcutFormat.ts";
import { keyboardCombo, linuxBindings, linuxMenuShortcuts, linuxNativeBindings, recordableShortcut, utilityBindings } from "../../shortcuts.ts";
import { MODIFIER_FLAGS, MODIFIER_KEYS } from "./../shortcutKeys.mac.ts";

const EF_SHIFT_DOWN = 2;
const EF_CONTROL_DOWN = 4;
const EF_ALT_DOWN = 8;
const EF_COMMAND_DOWN = 16;
const commandAt = (bindings, keyCode, modifiers) => bindings.find((binding) => binding.keyCode === keyCode && binding.modifiers === modifiers);
const event = (code, modifiers = {}) => ({ code, key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

test("the Mac's ⌘ is Chromium's EF_COMMAND_DOWN and ⌃ is EF_CONTROL_DOWN", () => {
  assert.deepEqual(MODIFIER_FLAGS, { command: EF_COMMAND_DOWN, control: EF_CONTROL_DOWN, option: EF_ALT_DOWN, shift: EF_SHIFT_DOWN, function: 0 });
  assert.deepEqual(MODIFIER_KEYS, { Meta: "command", Control: "control", Alt: "option", Shift: "shift" });
});

test("⌘T, ⌘S, ⌘,, ⌘W, ⌘L and ⌘N reach their commands from the ⌘ key", () => {
  const bindings = linuxBindings();
  for (const [code, command] of [["KeyT", "newTab"], ["KeyS", "toggleSidebar"], ["Comma", "openSettings"], ["KeyW", "closeTab"], ["KeyL", "focusCommandBar"], ["KeyN", "newWindow"]]) {
    const combo = keyboardCombo(event(code, { metaKey: true }));
    assert.deepEqual(combo.modifiers, ["command"]);
    assert.equal(combo.flags, EF_COMMAND_DOWN);
    assert.equal(commandAt(bindings, combo.keyCode, combo.flags)?.command, command, code);
  }
});

test("physical ⌃ is not ⌘: ⌃T opens nothing and ⌃⇥ is the tab switcher, since macOS keeps ⌘⇥ for itself", () => {
  const bindings = linuxBindings();
  const controlT = keyboardCombo(event("KeyT", { ctrlKey: true }));
  assert.deepEqual([controlT.modifiers, controlT.flags], [["control"], EF_CONTROL_DOWN]);
  assert.equal(commandAt(bindings, controlT.keyCode, controlT.flags), undefined);
  const switcher = keyboardCombo(event("Tab", { ctrlKey: true }));
  assert.equal(commandAt(bindings, switcher.keyCode, switcher.flags)?.command, "tabSwitcher");
  assert.equal(commandAt(bindings, switcher.keyCode, switcher.flags)?.arg, "forward");
  assert.equal(commandAt(bindings, 9, EF_COMMAND_DOWN), undefined);
});

test("the Mac keeps its own defaults: ⌘Q quits and Linux's F5, F6 and Ctrl+Shift+Q are not bound", () => {
  const bindings = linuxBindings();
  assert.equal(commandAt(bindings, 81, EF_COMMAND_DOWN)?.command, "quit");
  assert.equal(commandAt(bindings, 81, EF_COMMAND_DOWN | EF_SHIFT_DOWN), undefined);
  assert.equal(commandAt(bindings, 116, 0), undefined);
  assert.equal(commandAt(bindings, 117, 0), undefined);
  assert.equal(commandAt(bindings, 49, EF_COMMAND_DOWN)?.command, "selectTab");
});

test("⌘← and ⌘→ go back and forward only when no text field takes them, while ⌘[ and ⌘] always do", () => {
  const bindings = linuxBindings();
  assert.equal(commandAt(bindings, 37, EF_COMMAND_DOWN)?.command, "back");
  assert.equal(commandAt(bindings, 37, EF_COMMAND_DOWN)?.notInText, true);
  assert.equal(commandAt(bindings, 39, EF_COMMAND_DOWN)?.notInText, true);
  assert.equal(commandAt(bindings, 219, EF_COMMAND_DOWN)?.notInText, false);
  assert.equal(commandAt(bindings, 221, EF_COMMAND_DOWN)?.notInText, false);
  assert.equal(commandAt(bindings, 84, EF_COMMAND_DOWN)?.notInText, false);
  assert.equal(commandAt(bindings, 13, EF_COMMAND_DOWN)?.notInText, true);
});

test("remapping records the ⌘ key as command and displaced ⌘ defaults stay consumed", () => {
  const combo = keyboardCombo(event("KeyK", { metaKey: true, shiftKey: true }));
  assert.equal(recordableShortcut(event("KeyK", { metaKey: true })), true);
  const active = linuxBindings({ newTab: [""], focusCommandBar: [combo.key, ...combo.modifiers] });
  assert.equal(commandAt(active, 75, EF_COMMAND_DOWN | EF_SHIFT_DOWN)?.command, "focusCommandBar");
  const native = linuxNativeBindings(active);
  assert.equal(commandAt(native, 84, EF_COMMAND_DOWN)?.suppressed, true);
});

test("Settings keeps ⌘W and ⌘, in its utility window", () => {
  const bindings = utilityBindings(linuxBindings());
  assert.equal(commandAt(bindings, 87, EF_COMMAND_DOWN)?.command, "closeTab");
  assert.equal(commandAt(bindings, 188, EF_COMMAND_DOWN)?.command, "openSettings");
  assert.equal(commandAt(bindings, 84, EF_COMMAND_DOWN), undefined);
});

test("Mac shortcuts read as Mac glyphs, not Ctrl+", () => {
  assert.equal(formatShortcut({ key: "t", modifiers: ["command"] }), "⌘T");
  assert.equal(formatShortcut({ key: "\t", modifiers: ["control"] }).startsWith("⌃"), true);
  assert.equal(linuxMenuShortcuts().find((item) => item.id === "newTab").defaultKey, "t");
  assert.deepEqual(linuxMenuShortcuts().find((item) => item.id === "newTab").defaultModifiers, ["command"]);
});
