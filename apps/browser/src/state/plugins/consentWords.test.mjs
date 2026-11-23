import assert from "node:assert/strict";
import { test } from "node:test";
const { consentSource, consentVerb, consentVerbOf, CONSENT_WORDS } = await import("./consentWords.ts");

const NEW = "6".repeat(64);
const OLD = "4".repeat(64);

test("an official plugin you've never approved asks to Install; one with an earlier version on record asks to Update", () => {
  assert.equal(consentVerb(true, undefined, NEW), "install");
  assert.equal(consentVerb(true, { approved: null }, NEW), "install");
  assert.equal(consentVerb(true, { approved: OLD }, NEW), "update", "a 0.2.47 user reviewing 0.6.0 is updating, not installing");
  assert.equal(consentVerb(true, { approved: NEW }, NEW), "install", "asking again for the same approval isn't an update");
  assert.equal(consentVerb(false, { approved: OLD }, NEW), "turnOn", "a folder plugin is turned on, whatever its record");
  assert.deepEqual(CONSENT_WORDS.update, { title: "Update", button: "Update", done: "Updated" });
  assert.deepEqual(CONSENT_WORDS.install, { title: "Install", button: "Install", done: "Installed" });
  assert.deepEqual(CONSENT_WORDS.turnOn, { title: "Turn on", button: "Turn On", done: "Turned On" });
});

test("the sheet's words come from the request's listing and the plugin's record", () => {
  const candidate = { name: "cli", folderId: `official-${NEW}`, hash: NEW, official: true, manifest: { name: "cli", title: "Command Line", official: true } };
  const legacy = { name: "cli", folderId: "bundled", hash: OLD, official: true, legacy: true, manifest: { name: "cli", title: "Command Line", official: true } };
  const state = (records) => ({ listings: { cli: legacy }, candidates: { cli: candidate }, records });
  assert.equal(consentVerbOf(state({ cli: { enabled: true, approved: OLD, values: {}, applied: {} } }), "cli", NEW), "update");
  assert.equal(consentVerbOf(state({}), "cli", NEW), "install", "after Remove there's no record, so it's an install again");
  const folder = { name: "notes", folderId: "f", hash: NEW, manifest: { name: "notes" } };
  assert.equal(consentVerbOf({ listings: { notes: folder }, candidates: {}, records: { notes: { enabled: false, approved: OLD, values: {}, applied: {} } } }, "notes", NEW), "turnOn");
});

test("the sheet says where a plugin comes from and which version, leaving out a version it doesn't have", () => {
  assert.equal(consentSource(true, "1.0.0"), "Official · Version 1.0.0");
  assert.equal(consentSource(false, "2.0.0"), "From Your Plugins Folder · Version 2.0.0");
  assert.equal(consentSource(false, null), "From Your Plugins Folder");
});
