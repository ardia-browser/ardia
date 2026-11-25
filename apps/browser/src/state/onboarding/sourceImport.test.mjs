import assert from "node:assert/strict";
import { test } from "node:test";
import { windows } from "../../test-native/shell.ts";
import { patchImport } from "../import/flow.ts";
import { IMPORT_WINDOW_ID } from "../settings/settingsWindows.ts";
import { importedFrom, importFailed, importSucceeded, watchImportEnd } from "./sourceImport.ts";
import { importNow } from "../import/flow.ts";

test("closing the import window before it finishes ends the onboarding import, and closing it after keeps it", () => {
  let abandoned = 0;
  const stop = watchImportEnd(() => abandoned++);
  patchImport({ step: { name: "choose", error: "The selected file is invalid. Please try again." } });
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
  patchImport({ step: { name: "done", counts: {}, failures: [], notes: [], extensions: { profileId: "", list: [], opened: false, listing: null } } });
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
  patchImport({ step: { name: "progress", status: {}, preparing: 0 } });
  windows.emit({ type: "close", id: "settings" });
  assert.equal(abandoned, 1);
  stop();
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
});

const NO_EXTENSIONS = { profileId: "", list: [], opened: false, listing: null };
const done = (failures) => ({ name: "done", counts: {}, failures, notes: [], extensions: NO_EXTENSIONS });

test("an import counts as imported only when it finished with no failures, and names the browser it actually read", () => {
  patchImport({ source: { id: "firefox", name: "Firefox" }, step: { name: "progress", status: {}, preparing: 0 } });
  assert.deepEqual([importSucceeded(importNow()), importFailed(importNow()), importedFrom(importNow())], [false, false, null]);
  patchImport({ step: done([]) });
  assert.deepEqual([importSucceeded(importNow()), importFailed(importNow()), importedFrom(importNow())], [true, false, "Firefox"]);
  patchImport({ step: done([{ kind: "bookmarks", profiles: [] }]) });
  assert.deepEqual([importSucceeded(importNow()), importFailed(importNow())], [false, true]);
});

test("closing the import window after a failed import ends the onboarding import", () => {
  let abandoned = 0;
  const stop = watchImportEnd(() => abandoned++);
  patchImport({ step: done([{ kind: "bookmarks", profiles: [] }]) });
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
  stop();
});
