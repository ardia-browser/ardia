import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";

test("removing a plugin page's data works in a process that hasn't used WebKit yet", (t) => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-plugin-page-data-"));
  try {
    const binary = join(dir, "plugin-page-data-test");
    const built = spawnSync(swiftc, ["-parse-as-library", path("../ios/PluginCore/PluginPageData.swift"), path("./pluginPageData.test.swift"), "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, { encoding: "utf8", timeout: 30000 });
    assert.equal(ran.signal, null, `the removal crashed the process (${ran.signal})`);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.equal(ran.stdout.trim(), "removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
