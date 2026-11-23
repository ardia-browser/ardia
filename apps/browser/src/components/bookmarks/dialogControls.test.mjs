import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { controlSize } = await import("../ui/tokens.ts");
const { folderPicker } = await import("./tokens.ts");

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

test("large controls are one height, taller than the regular ones, with the tile radius", () => {
  assert.equal(controlSize.large.button, controlSize.large.field);
  assert.ok(controlSize.large.button > controlSize.regular.button);
  assert.equal(controlSize.large.radius, "tile");
  assert.equal(controlSize.regular.radius, "control");
});

test("both bookmark dialogs ask their Dialog for large controls", () => {
  for (const file of ["BookmarkDialog.tsx", "EditBookmarkDialog.tsx"]) assert.match(source(file), /<Dialog\b[^>]*\bcontrols="large"/, file);
});

test("the shared push button and text field take their size from the dialog", () => {
  assert.match(source("../ui/ButtonKinds.tsx"), /height: plain \? undefined : sized\.button/);
  assert.match(source("../ui/Field.tsx"), /height: multiline \? MULTILINE_HEIGHT : sized\.field/);
  assert.match(source("../ui/Dialog.tsx"), /<ControlSizeContext\.Provider value=\{controls\}>/);
});

test("the folder picker draws soft rows as tall as the large controls, with New Folder under the list", () => {
  assert.equal(folderPicker.row, controlSize.large.button);
  assert.match(source("DialogParts.tsx"), /look="soft"/);
  assert.doesNotMatch(source("DialogParts.tsx"), /fieldBorder/);
  assert.match(source("BookmarkDialog.tsx"), /footer=\{<FolderTreeAction title="New Folder…"/);
});

test("a softly selected folder keeps its ink and gains a checkmark, and the bookmarks page keeps the accent bar", () => {
  const tree = source("FolderTree.tsx");
  assert.match(tree, /look = "accent"/);
  assert.match(tree, /soft && selected \? <Symbol name="checkmark"/);
  assert.match(tree, /selected \? \(soft \? theme\.rowSelected : theme\.formAccent\)/);
});
