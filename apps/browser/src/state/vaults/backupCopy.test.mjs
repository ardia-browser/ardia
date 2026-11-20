import assert from "node:assert/strict";
import { test } from "node:test";
import { backupLine, restoredLine, restoreLine } from "./backupCopy.ts";

const now = Date.UTC(2026, 10, 13, 12);

test("a backup that waits on the keychain says so instead of claiming it backed up", () => {
  assert.equal(backupLine({ state: "waitingForKeychain", backedUpAt: now - 60_000 }, now), "Waiting for iCloud Keychain");
});

test("a failed backup names what to do, and a store it couldn't read isn't blamed on iCloud", () => {
  assert.equal(backupLine({ state: "failed", backedUpAt: null, problem: "iCloud" }, now), "Couldn't back up. Check that iCloud Drive is on.");
  assert.equal(backupLine({ state: "failed", backedUpAt: null, problem: "unreadable" }, now), "Couldn't read your passwords. Try again later.");
});

test("sync off shows no line, and a backup with no time reads as not yet", () => {
  assert.equal(backupLine({ state: "off", backedUpAt: null }, now), undefined);
  assert.equal(backupLine(null, now), undefined);
  assert.equal(backupLine({ state: "backedUp", backedUpAt: null }, now), "Not backed up yet");
});

test("the last backup reads as a relative time", () => {
  assert.equal(backupLine({ state: "backedUp", backedUpAt: now - 5 * 60_000 }, now), "Backed up 5 min ago");
});

test("restore counts read naturally, and a partial restore says what's left", () => {
  assert.equal(restoreLine(1), "1 login isn't on this Mac");
  assert.equal(restoreLine(3), "3 logins aren't on this Mac");
  assert.equal(restoredLine(0, 2), "Couldn't restore. Try again.");
  assert.equal(restoredLine(2, 1), "Restored 2. 1 didn't restore; try again.");
  assert.equal(restoredLine(1, 0), "Restored 1 login");
});

test("a backup deleted everywhere says so, and updates name their count", async () => {
  const { updateTitle, updatedLine } = await import("./backupCopy.ts");
  assert.equal(backupLine({ state: "deleted", backedUpAt: null }, now), "Not syncing");
  assert.equal(updateTitle(3), "Update 3 Passwords from iCloud");
  assert.equal(updateTitle(1), "Update 1 Password from iCloud");
  assert.equal(updatedLine(0, 1), "Couldn't update. Try again.");
});
