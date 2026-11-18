import assert from "node:assert/strict";
import test from "node:test";

test("Settings › Privacy shows View My Data once the shell has storage for the local copy", async () => {
  globalThis.indexedDB = { open() { throw new Error("unused"); } };
  globalThis.document = {};
  const index = await import("./settingsIndex.ts");
  assert.equal(index.settingUnavailable("privacy.viewData"), false);
  assert.equal(index.sectionUnavailable("privacy", "Kept on this Mac"), false);
  assert.ok(index.SETTINGS_INDEX.some((item) => item.entry.id === "privacy.viewData"));
});

test("Settings › Privacy offers the sharing toggle, as on the Mac", async () => {
  const index = await import("./settingsIndex.ts");
  assert.equal(index.settingUnavailable("privacy.shareDiagnostics"), false);
  assert.equal(index.sectionUnavailable("privacy", "Crash reports and usage"), false);
  assert.ok(index.SETTINGS_INDEX.some((item) => item.entry.id === "privacy.shareDiagnostics"));
});
