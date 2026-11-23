import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = join(root, "scripts/release/official-signatures.sh");
const onMac = process.platform === "darwin";

function compiled(path) {
  execFileSync("clang", ["-x", "c", "-", "-o", path], { input: "int main(void) { return 0; }\n" });
  return path;
}

function fixtures(programs, format = "gz") {
  const work = mkdtempSync(join(tmpdir(), "ac-signatures-src-"));
  const out = mkdtempSync(join(tmpdir(), "ac-signatures-"));
  mkdirSync(join(work, "cli", "bin"), { recursive: true });
  writeFileSync(join(work, "cli", "plugin.json"), "{}");
  for (const [name, make] of Object.entries(programs)) make(join(work, "cli", "bin", name));
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  if (format === "br") {
    const tarred = execFileSync("tar", ["-cf", "-", "-C", work, "cli"], { env, maxBuffer: 64 << 20 });
    const packed = execFileSync("swift", [join(root, "scripts/release/brotli.swift"), "encode"], { input: tarred, maxBuffer: 64 << 20 });
    writeFileSync(join(out, "cli-plugin-9.9.9-macos-arm64.tar.br"), packed);
  } else {
    execFileSync("tar", ["-czf", join(out, "cli-plugin-9.9.9-macos-arm64.tar.gz"), "-C", work, "cli"], { env });
  }
  return out;
}

function check(dir, env = {}) {
  const result = spawnSync(tool, [dir], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env } });
  return { status: result.status, out: result.stdout + result.stderr };
}

test("an ad hoc or unsigned program is a loud warning, not a failure: the pinned SHA-256 is what Ardia trusts", { skip: !onMac }, () => {
  const dir = fixtures({
    linked: (path) => compiled(path),
    adhoc: (path) => execFileSync("codesign", ["--force", "--sign", "-", compiled(path)]),
    unsigned: (path) => execFileSync("codesign", ["--remove-signature", compiled(path)]),
  });
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const { status, out } = check(dir, { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
  assert.equal(status, 0, out);
  assert.match(out, /WARN {2}cli\/bin\/linked is ad hoc signed \(by the linker\)/);
  assert.match(out, /WARN {2}cli\/bin\/adhoc is ad hoc signed/);
  assert.match(out, /WARN {2}cli\/bin\/unsigned is unsigned/);
  assert.match(out, /WARNING {2}cli-plugin-9\.9\.9: 3 of 3 Mach-O files aren't Developer ID signed/);
  assert.match(out, /^::warning::cli-plugin-9\.9\.9/m, "GitHub Actions gets an annotation");
  assert.match(readFileSync(summary, "utf8"), /⚠️ cli-plugin-9\.9\.9: 3 of 3 Mach-O files/, "and the release summary says so");
});

test("a signature that no longer verifies fails: the bytes were changed after signing", { skip: !onMac }, () => {
  const dir = fixtures({
    ardia: (path) => {
      execFileSync("codesign", ["--force", "--sign", "-", compiled(path)]);
      const fd = openSync(path, "r+");
      writeSync(fd, Buffer.from([0xff, 0xee, 0xdd, 0xcc]), 0, 4, 4000);
      closeSync(fd);
    },
  });
  const { status, out } = check(dir);
  assert.equal(status, 1, out);
  assert.match(out, /FAIL {2}cli\/bin\/ardia has a signature that doesn't verify/);
  assert.match(out, /FAIL {2}cli-plugin-9\.9\.9: 1 of 1 Mach-O files have a signature that is invalid or not team U5L5T3NGVV's/);
});

test("a valid signature from anyone but the expected team fails: that's a mix-up, not our build", { skip: !onMac }, () => {
  const dir = fixtures({ ardia: (path) => copyFileSync("/usr/bin/true", path) });
  const { status, out } = check(dir);
  assert.equal(status, 1, out);
  assert.match(out, /FAIL {2}cli\/bin\/ardia is signed by (macOS )?Software Signing \(team .+\), not Developer ID team U5L5T3NGVV/);
});

test("files that aren't Mach-O are left alone, and a folder with no pinned macOS tarball is an error", { skip: !onMac }, () => {
  const dir = fixtures({ "ardia.py": (path) => writeFileSync(path, "print('hi')\n") });
  const { status, out } = check(dir);
  assert.equal(status, 0, out);
  assert.match(out, /PASS {2}cli-plugin-9\.9\.9: no Mach-O files/);
  assert.notEqual(check(mkdtempSync(join(tmpdir(), "ac-signatures-empty-"))).status, 0);
});

test("a brotli tarball is read like a gzip one", { skip: !onMac }, () => {
  const dir = fixtures({ adhoc: (path) => execFileSync("codesign", ["--force", "--sign", "-", compiled(path)]) }, "br");
  const { status, out } = check(dir);
  assert.equal(status, 0, out);
  assert.match(out, /WARN {2}cli\/bin\/adhoc is ad hoc signed/);
  assert.match(out, /WARNING {2}cli-plugin-9\.9\.9: 1 of 1 Mach-O files aren't Developer ID signed/);
});

test("a gzip and a brotli tarball of the same name are each read alone", { skip: !onMac }, () => {
  const adhoc = (path) => execFileSync("codesign", ["--force", "--sign", "-", compiled(path)]);
  const dir = fixtures({ first: adhoc, second: adhoc });
  const brotli = fixtures({ only: adhoc }, "br");
  copyFileSync(join(brotli, "cli-plugin-9.9.9-macos-arm64.tar.br"), join(dir, "cli-plugin-9.9.9-macos-arm64.tar.br"));
  const { status, out } = check(dir);
  assert.equal(status, 0, out);
  assert.match(out, /cli-plugin-9\.9\.9: 2 of 2 Mach-O files/);
  assert.match(out, /cli-plugin-9\.9\.9: 1 of 1 Mach-O files/, "the brotli scan counts only what its own tarball holds");
});
