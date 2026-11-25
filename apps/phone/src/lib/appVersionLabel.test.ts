import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionLabel, TESTFLIGHT_RECEIPT_NAME } from "./appVersionLabel.ts";

const testFlight = TESTFLIGHT_RECEIPT_NAME;
const label = (releaseVersion: string, build: string, isDebug: boolean, receiptName: string | null) => appVersionLabel({ releaseVersion, build, receiptName }, isDebug);

test("a debug build or one without a release version is Dev, as main's AppVersionLabel", () => {
  assert.equal(label("0.2.47", "12", true, null), "Ardia Dev (12)");
  assert.equal(label("0.2.47-nightly.2", "12", true, testFlight), "Ardia Dev (12)");
  assert.equal(label("", "3", false, "receipt"), "Ardia Dev (3)");
  assert.equal(label("", "3", false, testFlight), "Ardia Dev (3)");
  assert.equal(label("1.0", "3", false, testFlight), "Ardia Dev (3)");
  assert.equal(label("0.2.47-beta.1", "3", false, testFlight), "Ardia Dev (3)");
});

test("TestFlight is Nightly, numbered for a nightly release", () => {
  assert.equal(label("0.2.47-nightly.2", "40", false, testFlight), "Ardia 0.2.47 Nightly 2 (40)");
  assert.equal(label("0.2.47", "41", false, testFlight), "Ardia 0.2.47 Nightly (41)");
});

test("the App Store is Stable", () => {
  assert.equal(label("0.2.47", "41", false, "receipt"), "Ardia 0.2.47 (41)");
  assert.equal(label("0.2.47-nightly.2", "40", false, "receipt"), "Ardia 0.2.47 (40)");
  assert.equal(label("0.2.47", "41", false, null), "Ardia 0.2.47 (41)");
});

test("a build with no store receipt, as Android's, reads Nightly from its own nightly version, beside iPhone's TestFlight label", () => {
  assert.equal(label("0.2.47-nightly.2", "204702", false, null), "Ardia 0.2.47 Nightly 2 (204702)");
  assert.equal(label("0.2.47", "204700", false, null), "Ardia 0.2.47 (204700)");
});
