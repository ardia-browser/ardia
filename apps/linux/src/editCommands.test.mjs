import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_ITEMS, createEditTargets, editField, editMenu } from "./editCommands.ts";

const element = (kind, extra = {}) => ({
  matches: (selector) => kind === "field" ? selector.startsWith("textarea") : false,
  closest: (selector) => (kind === "menu" && selector.includes("ardia-menu") ? {} : null),
  isConnected: true, selectionStart: 0, selectionEnd: 0, type: "text", value: "", readOnly: false, disabled: false,
  focused: 0,
  focus() { this.focused++; },
  ...extra,
});
const ids = (...actions) => new Set(EDIT_ITEMS.filter((item) => actions.includes(item.action)).map((item) => item.id));

test("the edit target is the shell text field that had focus before the menu took it, and the page otherwise", () => {
  const targets = createEditTargets();
  assert.deepEqual(targets.current(), { kind: "page" });
  const field = element("field");
  targets.focusIn(field);
  assert.equal(targets.current().field, field);
  targets.focusIn(element("menu"));
  assert.equal(targets.current().field, field, "opening the menu doesn't change what the entries act on");
  targets.pageFocused();
  assert.deepEqual(targets.current(), { kind: "page" }, "a page that took focus is the target, though the field is still the document's active element");
  targets.focusIn(field);
  field.isConnected = false;
  assert.deepEqual(targets.current(), { kind: "page" }, "a field that is gone hands over to the page");
  targets.focusIn(element("field"));
  targets.focusIn(element("button"));
  assert.deepEqual(targets.current(), { kind: "page" }, "a button isn't editable, so the page is");
  targets.focusIn(null);
  assert.deepEqual(targets.current(), { kind: "page" });
});

test("the entries show only when they can act, and Cut and Copy need a selection", () => {
  assert.equal(editMenu(null, true), null);
  assert.equal(editMenu({ kind: "page" }, false), null, "a host without tab.edit can't edit a page");
  assert.deepEqual(editMenu({ kind: "page" }, true), { disabled: new Set() });
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "" }) }, false).disabled, ids("cut", "copy", "selectAll"));
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 0, selectionEnd: 2 }) }, false).disabled, new Set());
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 0, selectionEnd: 2, type: "password" }) }, false).disabled, ids("cut", "copy"));
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 1, selectionEnd: 3, readOnly: true }) }, false).disabled, ids("undo", "redo", "cut", "paste", "pasteAndMatchStyle"));
  assert.equal(editMenu({ kind: "field", field: element("field", { disabled: true }) }, true), null);
  const throwing = element("field", { value: "1" });
  Object.defineProperty(throwing, "selectionStart", { get() { throw new Error("no selection on this input type"); } });
  assert.deepEqual(editMenu({ kind: "field", field: throwing }, false).disabled, ids("cut", "copy"));
});

test("a shell text field is edited with the web platform after it gets its focus back", async () => {
  const field = element("field", { value: "abc" });
  const run = [];
  const port = (paste, text = "clip") => ({ exec: (command, value) => (run.push([command, value]), command === "paste" ? paste : true), readClipboard: async () => text });
  for (const action of ["undo", "redo", "cut", "copy", "selectAll"]) assert.equal(await editField(field, action, port(true)), true);
  assert.deepEqual(run, [["undo", undefined], ["redo", undefined], ["cut", undefined], ["copy", undefined], ["selectAll", undefined]]);
  assert.equal(field.focused, 5);
  run.length = 0;
  assert.equal(await editField(field, "paste", port(true)), true);
  assert.deepEqual(run, [["paste", undefined]]);
  run.length = 0;
  assert.equal(await editField(field, "pasteAndMatchStyle", port(false)), true);
  assert.deepEqual(run, [["paste", undefined], ["insertText", "clip"]], "where the engine refuses a scripted paste, the clipboard's text is inserted");
  run.length = 0;
  assert.equal(await editField(field, "paste", port(false, "")), false);
  assert.deepEqual(run, [["paste", undefined]]);
  field.isConnected = false;
  run.length = 0;
  assert.equal(await editField(field, "copy", port(true)), false);
  assert.deepEqual(run, []);
});
