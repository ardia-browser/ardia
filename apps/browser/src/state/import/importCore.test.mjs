import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });
await import("../../test-native/index.ts");
const { noteImportCore, takeImportRuns } = await import("../telemetry/importRuns.ts");
const client = await import("../telemetry/client.ts");

after(() => client.setSharing(false, "settings"));

const read = (outcome, backend = "rust") => ({ format: "chromium_bookmarks", backend, outcome });

test("profiles with Chromium bookmarks count by the reader that parsed them, a profile without any isn't counted, and unreadable and oversized Bookmarks files count apart", () => {
  takeImportRuns();
  client.setSharing(true, "onboarding");
  const consent = client.consentToken();
  noteImportCore([read("ok"), read("notFound"), read("unreadable"), read("argument"), read("tooLarge")], consent);
  noteImportCore([read("ok", "native")], consent);
  noteImportCore(undefined, consent);
  const sent = takeImportRuns();
  assert.equal(sent.import_core_chromium_bookmarks_rust, 4);
  assert.equal(sent.import_core_chromium_bookmarks_native, 1);
  assert.equal(sent.import_core_chromium_bookmarks_unreadable, 2);
  assert.equal(sent.import_core_chromium_bookmarks_too_large, 1);
  const again = takeImportRuns();
  assert.equal(again.import_core_chromium_bookmarks_rust, 0);
});

test("nothing is counted while sharing is off", () => {
  takeImportRuns();
  client.setSharing(false, "settings");
  noteImportCore([read("ok"), read("tooLarge")], client.consentToken());
  const sent = takeImportRuns();
  assert.equal(sent.import_core_chromium_bookmarks_rust, 0);
  assert.equal(sent.import_core_chromium_bookmarks_too_large, 0);
});
