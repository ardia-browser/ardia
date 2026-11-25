import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const core = "../../../../packages/ardiacore/ios/";
const read = (path) => readFileSync(new URL(`${core}${path}`, import.meta.url), "utf8");
const bodyOf = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  return source.slice(start, source.indexOf("\n}", start));
};

test("a reserved key goes to the main menu only after a focused Developer Tools has had the chance to keep it", () => {
  const hook = bodyOf(read("ArdiaWindowController.mm"), "- (BOOL)window:(ArdiaCoreWindow *)window preHandleKeyEvent:");
  const keeps = hook.indexOf("KeepsReservedKeyInDevTools(window.window, event)");
  const refusal = hook.indexOf("return NO;");
  const menu = hook.indexOf("ArdiaPerformReservedKey(event)");
  assert.ok(keeps >= 0, "preHandleKeyEvent must ask KeepsReservedKeyInDevTools");
  assert.ok(keeps < refusal && refusal < menu, "a key Developer Tools keeps is refused before the main menu can run it");
});

test("Developer Tools keeps only ⇧⌘C, only while Copy URL owns it, and only with the focus inside its view", () => {
  const source = read("ArdiaReservedKeys.mm");
  const keeps = bodyOf(source, "bool KeepsReservedKeyInDevTools(NSWindow *window, NSEvent *event)");
  assert.match(keeps, /IsDevToolsPickerKey\(event\)/);
  assert.match(keeps, /kCopyUrlIdentifier/);
  assert.match(keeps, /firstResponder/);
  const picker = bodyOf(source, "bool IsDevToolsPickerKey(NSEvent *event)");
  assert.match(picker, /NSEventModifierFlagCommand \| NSEventModifierFlagShift/);
  assert.match(picker, /isEqualToString:@"c"/);
  const inside = bodyOf(source, "bool IsInDevTools(NSView *view)");
  assert.match(inside, /devtoolsView/);
  assert.match(inside, /isDescendantOf:/);
});

test("the shortcuts script expects a focused Developer Tools to own ⇧⌘C", () => {
  const script = readFileSync(new URL("../../scripts/shortcuts-test.mjs", import.meta.url), "utf8");
  assert.match(script, /\["⇧⌘C", [^\n]*\{ command: "copyUrl" \}[^\n]*"devtools-own"\]/);
});
