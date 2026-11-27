import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { androidVersion, macMarketingVersion } from "../../scripts/android-version.ts";
import { compareAndroidReleases, parseAndroidRelease } from "../lib/androidRelease.ts";
import { installedReleaseVersion, newerTaggedVersions } from "../lib/appUpdate.ts";

test("a stable release's code sits above every nightly of it", () => {
  assert.deepEqual(androidVersion("0.2.47"), { name: "0.2.47", code: 2047999, channel: "stable" });
  assert.deepEqual(androidVersion("0.2.47-nightly.4"), { name: "0.2.47-nightly.4", code: 2047004, channel: "nightly" });
  assert.ok(androidVersion("0.2.47-nightly.998").code < androidVersion("0.2.47").code);
});

test("each release's code is higher than the one before, across channels", () => {
  const order = ["0.2.46", "0.2.47-nightly.1", "0.2.47-nightly.2", "0.2.47", "0.2.48-nightly.1", "0.3.0-nightly.1", "0.3.0", "1.0.0"];
  const codes = order.map((release) => androidVersion(release).code);
  assert.deepEqual([...codes].sort((a, b) => a - b), codes);
  assert.equal(new Set(codes).size, codes.length);
});

test("every release is above the lab builds' versionCode 2 and the Compose app's 1", () => {
  assert.ok(androidVersion("0.1.0-nightly.1").code > 2);
  assert.throws(() => androidVersion("0.0.0-nightly.1"));
});

test("versions the code can't hold are refused", () => {
  for (const bad of ["0.2", "v0.2.47", "0.2.47-beta.1", "0.100.0", "0.2.1000", "0.2.47-nightly.0", "0.2.47-nightly.999", "21.0.0", "0.2.47-nightly.01", "1.0.04", "01.0.0"]) assert.throws(() => androidVersion(bad), bad);
});

test("without a version the Mac app's MARKETING_VERSION is the one, as for iPhone", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  assert.doesNotThrow(() => androidVersion(macMarketingVersion(root)));
});

test("the code is main's release-channel formula, so the Expo app updates over a Compose build released from main", () => {
  assert.equal(androidVersion("0.2.47-nightly.2").code, 0 * 100_000_000 + 2 * 1_000_000 + 47 * 1_000 + 2);
  assert.equal(androidVersion("1.0.0").code, 100_000_999);
  assert.ok(androidVersion("20.99.999").code <= 2_100_000_000);
});

test("the updater takes exactly the versions the release script builds, and orders them by the versionCode", () => {
  const versions = ["0.0.0", "0.0.1", "0.2.47", "0.2.47-nightly.1", "0.2.47-nightly.998", "0.2.47-nightly.999", "0.2.47-nightly.0", "0.2.47-nightly.01", "1.0.4-nightly.1000", "1.0.1000", "1.0.999", "1.99.0", "1.100.0", "20.99.999", "21.0.0", "01.0.0", "1.0.04", "1.0", "1.0.3-beta.1", "v1.0.3"];
  for (const text of versions) {
    let built: number | null;
    try {
      built = androidVersion(text).code;
    } catch {
      built = null;
    }
    assert.equal(parseAndroidRelease(text)?.code ?? null, built, text);
    assert.equal(installedReleaseVersion("android", text, false)?.code ?? null, built, text);
  }
  const order = ["0.2.46", "0.2.47-nightly.1", "0.2.47-nightly.2", "0.2.47", "0.2.48-nightly.1", "1.0.3-nightly.2", "1.0.3", "1.0.4-nightly.1"];
  const parsed = order.map((text) => parseAndroidRelease(text)!);
  assert.deepEqual([...parsed].sort(compareAndroidReleases).map((release) => release.text), order);
  const tags = order.map((text) => ({ ref: `refs/tags/android-v${text}` }));
  assert.deepEqual(newerTaggedVersions(tags, parseAndroidRelease("1.0.3-nightly.2")!).map((release) => release.text), ["1.0.4-nightly.1", "1.0.3"]);
});
