import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";

test("native messaging hosts send off the main thread, end with their extension and get killed after the grace period; extension access rules hold", (t) => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  if (spawnSync("/usr/bin/python3", ["-c", "1"]).status !== 0) return t.skip("python3 is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-native-host-"));
  try {
    const binary = join(dir, "native-host-test");
    const built = spawnSync(
      swiftc,
      ["-swift-version", "6", "-parse-as-library", path("../ios/WebKitExtensionNativeHost.swift"), path("../ios/WebKitExtensionShimNative.swift"), path("../ios/WebKitExtensionGrants.swift"), path("./webkit-native-host.test.swift"), "-o", binary],
      { encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, { encoding: "utf8", env: { ...process.env, TMPDIR: dir }, timeout: 60000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
