import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");
const patched = patch
  .split("\n")
  .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
  .map((line) => line.slice(1))
  .join("\n");

function updatePlaceholderBlock() {
  const start = patched.indexOf("self.placeholderAttributedString = [[NSAttributedString alloc]");
  assert.notEqual(start, -1, "the patch no longer sets the placeholder in _updatePlaceholder");
  const end = patched.indexOf("} // [Ardia]", start);
  assert.notEqual(end, -1, "the editor rewrite in _updatePlaceholder lost its closing Ardia marker");
  return patched.slice(start, end);
}

test("a secure field is built on AppKit's secure cell, so its editor is NSSecureTextView", () => {
  assert.match(patch, /@interface RCTUISecureTextFieldCell : NSSecureTextFieldCell/);
  assert.match(patch, /return RCTUISecureTextFieldCell\.class;/);
});

test("the placeholder update still reaches a secure field", () => {
  const block = updatePlaceholderBlock();
  const placeholder = block.indexOf("self.placeholderAttributedString =");
  const guard = block.indexOf("if (editor");
  assert.ok(placeholder !== -1 && guard > placeholder, "the placeholder must be set before the editor rewrite, outside its guard");
});

test("a focused secure field's editor is not set up again or rewritten run by run", () => {
  const block = updatePlaceholderBlock();
  const guard = block.match(/if \(editor[^\n]*\) \{/);
  assert.ok(guard, "the editor rewrite lost its guard");
  assert.match(
    guard[0],
    /!\[self\.cell isKindOfClass:NSSecureTextFieldCell\.class\]/,
    "NSSecureTextStorage keeps one font, not per-run attributes: writing a text-holding secure editor's runs back leaves it with no NSFont and drawRect: raises",
  );
  for (const call of [
    "setUpFieldEditorAttributes:editor",
    "setAttributes:attributes range:range",
    "editor.typingAttributes = typing",
  ]) {
    assert.ok(block.indexOf(call, block.indexOf(guard[0])) !== -1, `${call} must stay inside the guarded block`);
  }
});

test("the guard tests the cell, because the secure field answers isKindOfClass: NSSecureTextField for AppKit", () => {
  assert.match(patched, /return aClass == NSSecureTextField\.class \|\| \[super isKindOfClass:aClass\];/);
  assert.doesNotMatch(updatePlaceholderBlock(), /isKindOfClass:NSSecureTextField\.class/);
});
