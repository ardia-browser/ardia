import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SETTINGS } from "./settingsIndex.ts";

const REPO = new URL("../../../../../", import.meta.url);

const COPY_NAMING_THE_SYNC_PATH = [
  "apps/browser/src/components/settings/panes/SyncSheets.tsx",
  "apps/desktop/src/platform/linux/wording/syncWording.ts",
  "apps/phone/src/state/sync/syncRules.ts",
  "apps/phone/ios/Config/TestFlight-WhatToTest.txt",
  "packages/phone/android/src/main/java/com/ardia/sync/SyncJoin.kt",
  "packages/sync/ios/Core/RecoveryKit.swift",
];

const OLD_PATH = /Settings\s*(›|>|→|\\u203a)\s*Sync\b/;
const CURRENT_PATH = /Settings\s*(›|>)\s*General\s*(›|>)\s*Sync\b/;

test("Sync is a section of Settings › General, which the copy names", () => {
  const sync = SETTINGS.find((entry) => entry.title === "Sync" && entry.section === "Sync");
  assert.ok(sync, "the Sync row is missing from the settings index");
  assert.equal(sync.pane, "general");
  assert.equal(sync.paneTitle, "General");
});

for (const file of COPY_NAMING_THE_SYNC_PATH) {
  test(`${file} sends people to Settings › General › Sync, not Settings › Sync`, () => {
    const source = readFileSync(new URL(file, REPO), "utf8");
    const stale = source.split("\n").filter((line) => OLD_PATH.test(line));
    assert.deepEqual(stale, []);
    assert.match(source, CURRENT_PATH);
  });
}

test("the iPhone scan screen shows the shared Mac hint instead of its own path", () => {
  const scan = readFileSync(new URL("apps/phone/src/components/sync/SyncScan.tsx", REPO), "utf8");
  assert.match(scan, /\{MAC_HINT\}/);
  assert.doesNotMatch(scan, OLD_PATH);
});
