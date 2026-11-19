import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = join(root, "scripts/release/official-plugins.py");
const realPin = JSON.parse(readFileSync(join(root, "apps/browser/official-plugins.json"), "utf8"));

function run(args, { ok = true, arch } = {}) {
  const env = { ...process.env };
  delete env.ARDIA_ARCH;
  if (arch) env.ARDIA_ARCH = arch;
  const result = spawnSync("python3", ["-I", tool, ...args], { encoding: "utf8", env });
  if (ok) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, `expected a refusal, got: ${result.stdout}`);
  return result.stdout + result.stderr;
}

function tarball(dir, name, top, files, extra = () => {}) {
  const work = mkdtempSync(join(tmpdir(), "ac-pin-src-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(work, top, path, ".."), { recursive: true });
    writeFileSync(join(work, top, path), body);
  }
  chmodSync(join(work, top, "bin/ardia"), 0o755);
  extra(join(work, top));
  execFileSync("tar", ["-czf", join(dir, name), "-C", work, top], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

function scratch({ pluginVersion = "0.3.0", link = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ac-pin-"));
  const artifacts = join(dir, "artifacts");
  mkdirSync(artifacts);
  tarball(artifacts, "cli-plugin-0.3.0-macos-arm64.tar.gz", "cli", { "plugin.json": JSON.stringify({ manifest: 1, name: "cli", version: pluginVersion }), "bin/ardia": "#!/bin/sh\necho ardia 0.3.0\n" }, link ? (top) => symlinkSync("/etc/passwd", join(top, "bin/evil")) : undefined);
  tarball(artifacts, "ardia-cli-0.3.0-linux-x64.tar.gz", "ardia-cli-0.3.0", { "bin/ardia": "#!/bin/sh\necho ardia 0.3.0\n", "python/README": "python" });
  writeFileSync(join(artifacts, "install.sh"), readFileSync(join(root, "apps/cli/install.sh")));
  const pin = join(dir, "pin.json");
  const unpublished = structuredClone(realPin);
  Object.assign(unpublished.plugins[0], {
    version: "0.3.0",
    release: "https://github.com/ardia-browser/plugins/releases/download/cli-v0.3.0",
    artifacts: {
      "macos-arm64": { file: "cli-plugin-0.3.0-macos-arm64.tar.gz", sha256: null },
      "linux-x64": { file: "ardia-cli-0.3.0-linux-x64.tar.gz", sha256: null },
      installer: { file: "install.sh", sha256: null },
    },
  });
  writeFileSync(pin, JSON.stringify(unpublished));
  return { dir, artifacts, pin };
}

test("the checked-in pin is well formed and apps/cli/install.sh is its installer", () => {
  assert.match(run(["check"]), /1 pinned, 1 coming soon/);
});

test("an artifact that isn't published yet is refused with what to do", () => {
  const { dir, artifacts, pin } = scratch();
  const out = run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "plugins")], { ok: false });
  assert.match(out, /has no SHA-256 for cli-plugin-0\.3\.0-macos-arm64\.tar\.gz: publish it from its repo, then run official-plugins\.py pin cli 0\.3\.0/);
});

test("pinned, verified and unpacked: the bundle the release signs", () => {
  const { dir, artifacts, pin } = scratch();
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  const pinned = JSON.parse(readFileSync(pin, "utf8")).plugins[0];
  assert.match(pinned.artifacts["macos-arm64"].sha256, /^[0-9a-f]{64}$/);
  assert.equal(pinned.release, "https://github.com/ardia-browser/plugins/releases/download/cli-v0.3.0");
  run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "plugins")]);
  assert.deepEqual(readdirSync(join(dir, "plugins")), ["cli"]);
  assert.ok(existsSync(join(dir, "plugins/cli/bin/ardia")));
});

test("a changed artifact, a link inside it, or a folder whose version isn't the pinned one is refused", () => {
  const changed = scratch();
  run(["--pin", changed.pin, "--from", changed.artifacts, "pin", "cli", "0.3.0"]);
  writeFileSync(join(changed.artifacts, "cli-plugin-0.3.0-macos-arm64.tar.gz"), "swapped");
  assert.match(run(["--pin", changed.pin, "--from", changed.artifacts, "bundle", join(changed.dir, "plugins")], { ok: false }), /not the pinned/);
  const linked = scratch({ link: true });
  run(["--pin", linked.pin, "--from", linked.artifacts, "pin", "cli", "0.3.0"]);
  assert.match(run(["--pin", linked.pin, "--from", linked.artifacts, "bundle", join(linked.dir, "plugins")], { ok: false }), /link or a special file/);
  const other = scratch({ pluginVersion: "0.2.9" });
  run(["--pin", other.pin, "--from", other.artifacts, "pin", "cli", "0.3.0"]);
  assert.match(run(["--pin", other.pin, "--from", other.artifacts, "bundle", join(other.dir, "plugins")], { ok: false }), /says cli 0\.2\.9, not the pinned cli 0\.3\.0/);
});

test("Linux gets the pinned command under the app's version, the name its engine's installer expects", () => {
  const { dir, artifacts, pin } = scratch();
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  const out = join(dir, "ardia-cli-0.2.48-linux-x64.tar.gz");
  run(["--pin", pin, "--from", artifacts, "linux-cli", "0.2.48", out]);
  const names = execFileSync("tar", ["-tzf", out], { encoding: "utf8" }).trim().split("\n").sort();
  assert.ok(names.includes("ardia-cli-0.2.48/bin/ardia"), names.join(" "));
  assert.ok(names.every((n) => n.startsWith("ardia-cli-0.2.48")), names.join(" "));
  assert.match(readFileSync(`${out}.sha256`, "utf8"), /^[0-9a-f]{64} {2}ardia-cli-0\.2\.48-linux-x64\.tar\.gz\n$/);
});

test("an Intel build ships without a plugin that pins no macos-x64 folder, and arm64 builds don't notice", () => {
  const { dir, artifacts, pin } = scratch();
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  run(["--pin", pin, "bundled", "cli"]);
  run(["--pin", pin, "bundled", "cli"], { ok: false, arch: "x86_64" });
  assert.match(run(["--pin", pin, "describe"], { arch: "x86_64" }), /^plugin cli 0\.3\.0 none \(no macos-x64 folder pinned\)$/m);
  const out = run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "intel")], { arch: "x86_64" });
  assert.match(out, /cli 0\.3\.0: no macos-x64 folder pinned, so this build ships without it/);
  assert.deepEqual(readdirSync(join(dir, "intel")), []);
  run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "arm")]);
  assert.deepEqual(readdirSync(join(dir, "arm")), ["cli"]);
  run(["--pin", pin, "bundled", "cli"], { ok: false, arch: "ppc" });
});

test("a macos-x64 folder is pinned, verified and bundled for Intel builds only", () => {
  const { dir, artifacts, pin } = scratch();
  tarball(artifacts, "cli-plugin-0.3.0-macos-x64.tar.gz", "cli", { "plugin.json": JSON.stringify({ manifest: 1, name: "cli", version: "0.3.0" }), "bin/ardia": "#!/bin/sh\necho intel\n" });
  const unpublished = JSON.parse(readFileSync(pin, "utf8"));
  unpublished.plugins[0].artifacts["macos-x64"] = { file: "cli-plugin-0.3.0-macos-x64.tar.gz", sha256: null };
  writeFileSync(pin, JSON.stringify(unpublished));
  assert.match(run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "early")], { ok: false, arch: "x86_64" }), /has no SHA-256 for cli-plugin-0\.3\.0-macos-x64\.tar\.gz/);
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  const pinned = JSON.parse(readFileSync(pin, "utf8")).plugins[0].artifacts;
  assert.match(pinned["macos-x64"].sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(pinned["macos-x64"].sha256, pinned["macos-arm64"].sha256);
  run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "intel")], { arch: "x86_64" });
  assert.equal(readFileSync(join(dir, "intel/cli/bin/ardia"), "utf8"), "#!/bin/sh\necho intel\n");
  run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "arm")]);
  assert.equal(readFileSync(join(dir, "arm/cli/bin/ardia"), "utf8"), "#!/bin/sh\necho ardia 0.3.0\n");
});
