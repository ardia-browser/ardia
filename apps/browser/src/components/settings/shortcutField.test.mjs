import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { createElement } = require("react");
const { pressables } = await import("react-native");
const { ShortcutField } = await import("./ShortcutField.tsx");

const render = (props) => {
  pressables.length = 0;
  renderToStaticMarkup(createElement(ShortcutField, { remappable: true, recording: false, onRecord() {}, onClear() {}, onClearMouse() {}, ...props }));
  return { buttons: pressables.map((p) => ({ label: p.accessibilityLabel, role: p.accessibilityRole, focusable: p.focusable, pointerEvents: p.pointerEvents, press: p.onPress })) };
};

test("Remove Shortcut is a focusable button before any pointer hover, so the keyboard reaches it, and stays out of the pointer's way until shown", () => {
  let cleared = 0;
  const { buttons } = render({ combo: { key: "s", modifiers: ["command"] }, onClear: () => void cleared++ });
  const remove = buttons.find((b) => b.label === "Remove Shortcut");
  assert.ok(remove, "the clear button only existed while the pointer hovered the key cap");
  assert.equal(remove.role, "button");
  assert.equal(remove.focusable, true);
  assert.equal(remove.pointerEvents, "none", "an unshown clear button must not take a click meant for the key cap");
  remove.press();
  assert.equal(cleared, 1);
  const keyCap = buttons.find((b) => b.label?.startsWith("Shortcut "));
  assert.equal(keyCap?.focusable, true);
  assert.equal(keyCap?.role, "button");
});

test("a shortcut field with nothing bound offers nothing to remove", () => {
  const { buttons } = render({ combo: { key: "", modifiers: [] } });
  assert.deepEqual(buttons.map((b) => b.label), ["No shortcut"]);
});

test("a mouse button bound to the command shows beside its keys, with its own keyboard-reachable remove button", () => {
  let mouseCleared = 0;
  const { buttons } = render({ combo: { key: "s", modifiers: ["command"] }, mouse: { key: "mouse:middle", modifiers: [] }, onClearMouse: () => void mouseCleared++ });
  assert.deepEqual(buttons.map((b) => b.label), ["Shortcut ⌘S", "Remove Shortcut", "Remove Mouse Shortcut"]);
  const remove = buttons.find((b) => b.label === "Remove Mouse Shortcut");
  assert.equal(remove?.focusable, true);
  remove.press();
  assert.equal(mouseCleared, 1);
});

test("the Auto-hide tabs row shows the command's mouse binding, as Keyboard Shortcuts does", () => {
  const source = readFileSync(new URL("./ShortcutField.tsx", import.meta.url), "utf8");
  const field = source.slice(source.indexOf("export function CommandKeyField"), source.indexOf("type ShortcutFieldProps"));
  assert.match(field, /<ShortcutField[\s\S]*mouse=\{resolved\.mouse\.get\(command\)\}[\s\S]*onClearMouse=/);
});
