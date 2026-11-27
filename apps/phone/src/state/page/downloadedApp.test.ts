import assert from "node:assert/strict";
import { test } from "node:test";
import { opensInInstaller } from "./pagePrompts.ts";

test("on Android a downloaded APK opens through Ardia's installer path, everything else as before", () => {
  for (const name of ["Ardia-1.0.2.apk", "other.APK", " app.apk "]) assert.equal(opensInInstaller("android", name), true, name);
  for (const name of ["report.pdf", "app.apk.txt", "apk", "photo.jpg"]) assert.equal(opensInInstaller("android", name), false, name);
  assert.equal(opensInInstaller("ios", "Ardia-1.0.2.apk"), false);
});
