import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { __ARDIA_VERSION__: "1.0.0", __ARDIA_BUILD__: "1", __ARDIA_NATIVE_API_VERSION__: 64, __ARDIA_DEBUG__: false, __ARDIA_UPDATE_REPOSITORY__: "x/y" });

const { menuStore } = await import("./store");
const { linuxShortcutOf, withLinuxShortcuts } = await import("./menuShortcuts");

test("a Mac combo from the UI becomes its row's Linux combo, else Cmd becomes Ctrl", () => {
  menuStore.update({});
  assert.deepEqual(linuxShortcutOf("[", ["command"]), { code: "BracketLeft", ctrl: true, shift: false, alt: false });
  assert.deepEqual(linuxShortcutOf("", ["command"]), { code: "ArrowLeft", ctrl: false, shift: false, alt: true });
  assert.deepEqual(linuxShortcutOf("t", ["command", "shift"]), { code: "KeyT", ctrl: true, shift: true, alt: false });
  assert.deepEqual(linuxShortcutOf("j", ["command", "option"]), { code: "KeyJ", ctrl: true, shift: true, alt: false });
  assert.deepEqual(linuxShortcutOf("y", ["command"]), { code: "KeyH", ctrl: true, shift: false, alt: false });
  assert.equal(linuxShortcutOf("q", []), null);
});

test("menu items and their children get the shortcut, other fields stay", () => {
  menuStore.update({});
  const items = withLinuxShortcuts([{ id: "a", title: "A", key: "w", modifiers: ["command"], children: [{ id: "b", key: "l", modifiers: ["command"] }] }, { separator: true }]) as Record<string, unknown>[];
  assert.deepEqual(items[0]!.shortcut, { code: "KeyW", ctrl: true, shift: false, alt: false });
  assert.deepEqual((items[0]!.children as Record<string, unknown>[])[0]!.shortcut, { code: "KeyL", ctrl: true, shift: false, alt: false });
  assert.equal(items[0]!.title, "A");
  assert.deepEqual(items[1], { separator: true });
});
