import assert from "node:assert/strict";
import { test } from "node:test";
const { nextDialogButton } = await import("./dialogFocus.ts");

const DIALOG = 1;

test("Tab from the dialog itself goes to the first button, Shift-Tab to the last", () => {
  assert.equal(nextDialogButton([11, 12], DIALOG, DIALOG, false), 0);
  assert.equal(nextDialogButton([11, 12], DIALOG, DIALOG, true), 1);
});

test("Tab and Shift-Tab wrap around the buttons", () => {
  assert.equal(nextDialogButton([11, 12], 11, DIALOG, false), 1);
  assert.equal(nextDialogButton([11, 12], 12, DIALOG, false), 0);
  assert.equal(nextDialogButton([11, 12], 11, DIALOG, true), 1);
  assert.equal(nextDialogButton([11, 12, 13], 13, DIALOG, true), 1);
});

test("Tab and Shift-Tab stay on a dialog's only button", () => {
  assert.equal(nextDialogButton([11], 11, DIALOG, false), 0);
  assert.equal(nextDialogButton([11], 11, DIALOG, true), 0);
});

test("a disabled button is skipped both ways", () => {
  assert.equal(nextDialogButton([11, null, 13], 11, DIALOG, false), 2);
  assert.equal(nextDialogButton([11, null, 13], 13, DIALOG, true), 0);
  assert.equal(nextDialogButton([null, 12], DIALOG, DIALOG, false), 1);
});

test("Tab from another control, such as a text field, is left to the platform", () => {
  const textField = 999;
  assert.equal(nextDialogButton([11, 12], textField, DIALOG, false), null);
  assert.equal(nextDialogButton([11, null], null, DIALOG, true), null);
  assert.equal(nextDialogButton([11, 12], undefined, DIALOG, false), null);
});

test("a dialog with no enabled button keeps Tab but moves nothing", () => {
  assert.equal(nextDialogButton([], DIALOG, DIALOG, false), -1);
  assert.equal(nextDialogButton([null, null], DIALOG, DIALOG, true), -1);
});
