import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createWindowsUpdateCounts } from "../../../../packages/expo-windows/src/updater/counts.ts";
import { failureText, feedNotPublished, folderOf, isValidPublishedUnder, megabytes, offered, parseVerifiedUpdate, readBuild, readManifest } from "../../../../packages/expo-windows/src/updater/manifest.ts";
import { noteReleaseNotesHeldForFirstRun, takeFirstRunCounts } from "../state/telemetry/firstRunCounts.ts";

const under = "https://github.com/ardia-browser/ardia/releases/download/";
const sha = "a".repeat(64);
const installer = (name) => ({ url: `${under}windows-alpha/${name}`, sha256: sha, bytes: 180_000_000 });
const manifest = (changes = {}) => JSON.stringify({ version: "0.2.46", build: 60, x64: installer("Ardia-Setup-x64.exe"), arm64: installer("Ardia-Setup-arm64.exe"), ...changes });

test("a published manifest reads with both installers", () => {
  const read = readManifest(manifest(), under);
  assert.equal(read.build, 60);
  assert.equal(read.version, "0.2.46");
  assert.equal(read.installers.x64.url, `${under}windows-alpha/Ardia-Setup-x64.exe`);
  assert.equal(read.installers.arm64.bytes, 180_000_000);
});

test("a manifest that is not JSON, not an object, or has no usable build is refused", () => {
  for (const text of [
    "",
    "<html>",
    "[]",
    "null",
    JSON.stringify({ version: "1" }),
    manifest({ build: 0 }),
    manifest({ build: 1.5 }),
    manifest({ build: "60" }),
    manifest().replace('"build":60', '"build":60.0'),
    manifest().replace('"build":60', '"build":6e1'),
    manifest().replace('"bytes":180000000', '"bytes":1e2'),
    manifest().replace('"bytes":180000000', '"bytes":180000000.0'),
    manifest({ version: "" }),
    manifest({ version: "constructor" }),
    manifest({ version: "a b" }),
    manifest({ extra: 1 }),
  ]) {
    assert.equal(readManifest(text, under), null, text);
  }
  assert.equal(readManifest(manifest({ version: "1" }), under)?.version, "1");
});

test("an installer from another address, with another ending, or a path that climbs refuses the manifest", () => {
  const bad = [
    { ...installer("Ardia-Setup-x64.exe"), url: "https://example.com/Ardia-Setup-x64.exe" },
    { ...installer("Ardia-Setup-x64.exe"), url: "http://github.com/ardia-browser/ardia/releases/download/windows-alpha/Ardia-Setup-x64.exe" },
    { ...installer("Ardia-Setup-x64.exe"), url: `${under}windows-alpha/Ardia-Setup-x64.msi` },
    { ...installer("Ardia-Setup-x64.exe"), url: `${under}../../../other/repo/releases/download/x/Setup.exe` },
    { ...installer("Ardia-Setup-x64.exe"), url: `${under}windows-alpha/Ardia Setup.exe` },
    { ...installer("Ardia-Setup-x64.exe"), url: `${under}windows-alpha/Setup.exe?x=1.exe` },
    { ...installer("Ardia-Setup-x64.exe"), url: `${under}windows-alpha/%2e%2e/Setup.exe` },
    { ...installer("Ardia-Setup-x64.exe"), sha256: sha.toUpperCase() },
    { ...installer("Ardia-Setup-x64.exe"), sha256: "abc" },
    { ...installer("Ardia-Setup-x64.exe"), bytes: 0 },
    { ...installer("Ardia-Setup-x64.exe"), bytes: 2 ** 31 },
    { ...installer("Ardia-Setup-x64.exe"), bytes: "180000000" },
    "Ardia-Setup-x64.exe",
  ];
  for (const x64 of bad) {
    assert.equal(readManifest(manifest({ x64 }), under), null, JSON.stringify(x64));
  }
});

test("only a higher build with an installer for this processor is offered", () => {
  const read = readManifest(manifest(), under);
  assert.equal(offered(read, "x64", 59).url, `${under}windows-alpha/Ardia-Setup-x64.exe`);
  assert.equal(offered(read, "arm64", 1).url, `${under}windows-alpha/Ardia-Setup-arm64.exe`);
  assert.equal(offered(read, "x64", 60), null);
  assert.equal(offered(read, "x64", 61), null);
  assert.equal(offered(read, "x86", 1), null);
  assert.equal(offered(read, "__proto__", 1), null);
  assert.equal(offered(readManifest(manifest({ arm64: undefined }), under), "arm64", 1), null);
});

test("the build file beside the app reads, and anything else means no identity", () => {
  assert.deepEqual(readBuild('{"version":"0.2.46-nightly.5","build":57}'), { version: "0.2.46-nightly.5", build: 57 });
  for (const text of ["", "{}", '{"version":"0.2.46"}', '{"version":"0.2.46","build":-1}', '{"build":57}']) assert.equal(readBuild(text), null, text);
});

test("a test feed's installers must sit in the feed's own folder, and plain http is limited to local test hosts", () => {
  const feed = "http://10.0.2.2:18770/feed/windows-update.json";
  assert.equal(folderOf(feed), "http://10.0.2.2:18770/feed/");
  assert.equal(isValidPublishedUnder("http://10.0.2.2:18770/feed/"), true);
  assert.equal(isValidPublishedUnder("http://127.0.0.1:18770/feed/"), true);
  assert.equal(isValidPublishedUnder("http://example.com/feed/"), false);
  const local = { url: "http://10.0.2.2:18770/feed/Ardia-Setup-arm64.exe", sha256: sha, bytes: 10 };
  assert.ok(readManifest(manifest({ x64: undefined, arm64: local }), folderOf(feed)).installers.arm64);
  assert.equal(readManifest(manifest({ x64: undefined, arm64: installer("Ardia-Setup-arm64.exe") }), folderOf(feed)), null);
});

test("readManifest agrees with every shared Windows vector in core-rs", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../../../packages/core-rs/tests/update-vectors.json", import.meta.url), "utf8"));
  assert.ok(vectors.windows.length >= 40);
  for (const entry of vectors.windows) {
    const parsed = readManifest(entry.manifest, entry.publishedUnder);
    if (entry.parse.error === "kind") {
      assert.ok(parsed, entry.name);
      assert.equal(parsed.installers[entry.cpu], undefined, entry.name);
    } else if (entry.parse.error) {
      assert.equal(parsed, null, entry.name);
    } else {
      assert.ok(parsed, entry.name);
      assert.equal(parsed.version, entry.parse.version, entry.name);
      assert.equal(parsed.build, entry.parse.build, entry.name);
      assert.deepEqual(parsed.installers[entry.cpu], { url: entry.parse.url, sha256: entry.parse.sha256, bytes: entry.parse.bytes }, entry.name);
    }
  }
});

test("parseVerifiedUpdate validates verified answers and preserves failure reasons without trusting forged replies", () => {
  const ok = parseVerifiedUpdate(
    JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: `${under}windows-alpha/Ardia-Setup-x64-60.exe`, sha256: sha, bytes: 180_000_000 }),
    under,
    59,
  );
  assert.equal(ok.status, "ok");
  assert.equal(ok.build, 60);
  assert.equal(ok.installer.bytes, 180_000_000);

  assert.deepEqual(parseVerifiedUpdate(JSON.stringify({ status: "upToDate" }), under, 59), { status: "upToDate" });
  assert.deepEqual(parseVerifiedUpdate(JSON.stringify({ status: "notPublished" }), under, 59), { status: "notPublished" });
  assert.deepEqual(parseVerifiedUpdate(JSON.stringify({ status: "failed", reason: "notNewer", message: "old" }), under, 59), { status: "upToDate" });
  assert.deepEqual(parseVerifiedUpdate(JSON.stringify({ status: "failed", reason: "kind", message: "no arm64" }), under, 59), { status: "upToDate" });

  const badSig = parseVerifiedUpdate(JSON.stringify({ status: "failed", reason: "signature", message: "bad sig" }), under, 59);
  assert.deepEqual(badSig, { status: "failed", reason: "signature", message: "bad sig" });

  const unknownReason = parseVerifiedUpdate(JSON.stringify({ status: "failed", reason: "custom", message: "weird" }), under, 59);
  assert.deepEqual(unknownReason, { status: "failed", reason: "other", message: "weird" });

  const downgrade = parseVerifiedUpdate(
    JSON.stringify({ status: "ok", version: "0.2.48", build: 59, url: `${under}windows-alpha/Ardia-Setup-x64-59.exe`, sha256: sha, bytes: 10 }),
    under,
    59,
  );
  assert.equal(downgrade.status, "failed");
  assert.equal(downgrade.reason, "manifest");

  const badHost = parseVerifiedUpdate(
    JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: "https://example.com/Setup.exe", sha256: sha, bytes: 10 }),
    under,
    59,
  );
  assert.equal(badHost.status, "failed");
  assert.equal(badHost.reason, "manifest");

  const garbage = parseVerifiedUpdate("not json", under, 59);
  assert.equal(garbage.status, "failed");
  assert.equal(garbage.reason, "verifier");
});

test("Windows update verification telemetry counts obey consent epochs and stay empty off Windows", async () => {
  const counts = createWindowsUpdateCounts();
  counts.note("signature");
  assert.deepEqual(counts.takeCounts(), {});
  const offStart = counts.consentEpoch();
  counts.setConsentEpoch("e1");
  counts.note("verified", offStart);
  assert.deepEqual(counts.takeCounts(), {});
  const e1Start = counts.consentEpoch();
  counts.note("verified", e1Start);
  counts.note("signature", e1Start);
  counts.note("signature", e1Start);
  assert.deepEqual(counts.takeCounts(), {
    e1: { verified: 1, signature: 2, manifest: 0, tooLarge: 0, missing: 0, network: 0, verifier: 0, other: 0 },
  });
  assert.deepEqual(counts.takeCounts(), {});
  counts.note("manifest", e1Start);
  counts.setConsentEpoch("e2");
  counts.note("verified", e1Start);
  assert.deepEqual(counts.takeCounts(), {});
  counts.setConsentEpoch("");
  counts.note("network", "e2");
  counts.note("network");
  assert.deepEqual(counts.takeCounts(), {});

  const { takeWindowsUpdateCounts } = await import("../state/telemetry/windowsUpdateCounts.ts");
  assert.deepEqual(takeWindowsUpdateCounts(), {});
});

test("a failed check is told in words, whatever shape the failure has", () => {
  assert.equal(failureText(new Error("the server answered 404")), "the server answered 404");
  assert.equal(failureText({ message: "the server answered 404", code: "EUNSPECIFIED" }), "the server answered 404");
  assert.equal(failureText("no answer"), "no answer");
  for (const odd of [{}, { message: 5 }, null, undefined, 7, ""]) assert.equal(failureText(odd), "the check failed");
});

test("sizes are shown in whole megabytes, never zero", () => {
  assert.equal(megabytes(180_000_000), 172);
  assert.equal(megabytes(10), 1);
});

test("a feed the server doesn't have is told apart from other failures", () => {
  assert.equal(feedNotPublished(new Error("the server answered 404")), true);
  assert.equal(feedNotPublished("the server answered 404"), true);
  assert.equal(feedNotPublished(new Error("the server answered 500")), false);
  assert.equal(feedNotPublished(new Error("the server answered 4040")), false);
  assert.equal(feedNotPublished(new Error("the update feed could not be read")), false);
  assert.equal(feedNotPublished(null), false);
});

test("release notes held back for a first run are counted and reset once taken", () => {
  takeFirstRunCounts();
  noteReleaseNotesHeldForFirstRun();
  assert.deepEqual(takeFirstRunCounts(), { release_notes_held_for_first_run: 1 });
  assert.deepEqual(takeFirstRunCounts(), { release_notes_held_for_first_run: 0 });
});
