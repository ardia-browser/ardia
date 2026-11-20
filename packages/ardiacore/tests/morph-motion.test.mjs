import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";

function testingToolchain() {
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  const compiler = spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" });
  if (developer.status !== 0 || compiler.status !== 0) return null;
  return {
    frameworks: join(developer.stdout.trim(), "Platforms/MacOSX.platform/Developer/Library/Frameworks"),
    macros: join(dirname(compiler.stdout.trim()), "../lib/swift/host/plugins/testing/libTestingMacros.dylib"),
  };
}

test("the Library morph's room spring and late-frame count pass their Swift tests", (t) => {
  const toolchain = testingToolchain();
  if (!toolchain) return t.skip("Xcode's Swift Testing is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-morph-motion-"));
  try {
    const binary = join(dir, "morph-motion-test");
    const built = spawnSync(
      swiftc,
      [
        "-swift-version", "6", "-parse-as-library",
        "-F", toolchain.frameworks, "-Xlinker", "-rpath", "-Xlinker", toolchain.frameworks,
        "-load-plugin-library", toolchain.macros,
        path("../ios/MorphMotion.swift"), path("./morph-motion.test.swift"), "-o", binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
