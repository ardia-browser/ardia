import assert from "node:assert/strict";
import { test } from "node:test";
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");
const { noteCliPillShown, takeCliCounts } = await import("../telemetry/cliCounts.ts");

test("the control pill shows in full unless the compact switch is on, and config.json can set it", () => {
  assert.equal(DEFAULT_SETTINGS.compactCliPill, false);
  assert.equal(isConfigSettingKey("compactCliPill"), true);
});

test("every pill shown is counted, and the compact ones again on their own", () => {
  takeCliCounts();
  noteCliPillShown(false);
  noteCliPillShown(true);
  noteCliPillShown(true);
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_pill_shows, counts.cli_pill_compact_shows], [3, 2]);
  assert.deepEqual([takeCliCounts().cli_pill_shows, takeCliCounts().cli_pill_compact_shows], [0, 0]);
});
