import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { readerButtonShown } = await import("./ReaderControls.tsx");

test("the Reader button shows while reading, and when the page has reader content and the field's buttons are out", () => {
  assert.equal(readerButtonShown(undefined, false), false);
  assert.equal(readerButtonShown({ active: false, available: false }, false), false);
  assert.equal(readerButtonShown({ active: false, available: true }, false), true);
  assert.equal(readerButtonShown({ active: false, available: true }, true), false);
  assert.equal(readerButtonShown({ active: true, available: true }, true), true);
});

test("the toolbar mounts the Reader button only when it shows", () => {
  const toolbar = readFileSync(new URL("../toolbar/Toolbar.tsx", import.meta.url), "utf8");
  assert.match(toolbar, /\{reader && <ReaderButton /);
});
