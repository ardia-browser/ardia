import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");
const from = patch.indexOf("diff --git a/Libraries/Text/TextInput/Singleline/RCTUITextField.mm");
const to = patch.indexOf("\ndiff --git ", from + 1);
const patchedTextField = patch
  .slice(from, to)
  .split("\n")
  .filter((line) => (line.startsWith(" ") || line.startsWith("+")) && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");

function textDidChange() {
  const start = patchedTextField.indexOf("_textWasPasted = NO;");
  assert.notEqual(start, -1, "the patch doesn't change RCTUITextField's _textDidChange, which sets the field's whole value on every keystroke");
  return patchedTextField.slice(start, patchedTextField.indexOf("#endif // macOS]", start));
}

test("a single-line field being edited restyles its text in place, so AppKit keeps the typing's undo", () => {
  assert.match(
    textDidChange(),
    /NSTextView \*editor = \(NSTextView \*\)self\.currentEditor;[^\n]*\n\s*if \(editor && !editor\.hasMarkedText\) \{\n\s*\[editor\.textStorage setAttributes:\[self defaultTextAttributes\] range:NSMakeRange\(0, editor\.textStorage\.length\)\];/,
  );
});

test("the field's value is set again only when nothing is editing it or an input method holds marked text", () => {
  const body = textDidChange();
  const inPlace = body.indexOf("setAttributes:[self defaultTextAttributes]");
  const replaced = body.indexOf("[self setAttributedText:");
  assert.ok(inPlace !== -1 && replaced > inPlace, "setAttributedText: still runs while the field is being edited");
  assert.match(body.slice(inPlace, replaced), /\} else \{/);
  assert.equal(body.split("[self setAttributedText:").length, 2);
});
