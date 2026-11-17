import assert from "node:assert/strict";
import test from "node:test";

test("Settings › General › Crash reports opens the details that hold View My Data, and searching for it finds them", async () => {
  const index = await import("./settingsIndex.ts");
  assert.equal(index.settingUnavailable("general.crashDetails"), false);
  assert.equal(index.sectionUnavailable("general", "Crash reports"), false);
  const details = index.SETTINGS_INDEX.find((item) => item.entry.id === "general.crashDetails");
  assert.ok(details);
  assert.ok(["view my data", "local copy"].every((keyword) => details.entry.keywords.includes(keyword)));
});

test("Settings › General offers the sharing toggle, as on the Mac", async () => {
  const index = await import("./settingsIndex.ts");
  assert.equal(index.settingUnavailable("general.shareDiagnostics"), false);
  assert.equal(index.sectionUnavailable("general", "Crash reports"), false);
  assert.ok(index.SETTINGS_INDEX.some((item) => item.entry.id === "general.shareDiagnostics"));
});
