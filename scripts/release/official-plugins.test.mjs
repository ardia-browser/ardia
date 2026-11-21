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

function run(args, { ok = true } = {}) {
  const result = spawnSync("python3", ["-I", tool, ...args], { encoding: "utf8" });
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
  tarball(artifacts, "cli-plugin-0.3.0-macos-arm64.tar.gz", "cli", { "plugin.json": JSON.stringify({ manifest: 1, name: "cli", version: pluginVersion, programs: [{ name: "ardia", path: "bin/ardia" }] }), "bin/ardia": "#!/bin/sh\necho ardia 0.3.0\n" }, link ? (top) => symlinkSync("/etc/passwd", join(top, "bin/evil")) : undefined);
  tarball(artifacts, "ardia-cli-0.3.0-linux-x64.tar.gz", "ardia-cli-0.3.0", { "bin/ardia": "#!/bin/sh\necho ardia 0.3.0\n", "python/README": "python" });
  writeFileSync(join(artifacts, "install.sh"), readFileSync(join(root, "apps/cli/install.sh")));
  const pin = join(dir, "pin.json");
  const unpublished = structuredClone(realPin);
  unpublished.plugins = unpublished.plugins.filter((plugin) => plugin.name === "cli");
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
  assert.match(run(["check"]), new RegExp(`${realPin.plugins.length} pinned, ${realPin.comingSoon.length} coming soon`));
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
  assert.deepEqual(readdirSync(join(dir, "plugins")), ["cli", "program-registry.json"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugins", "program-registry.json"), "utf8")).claims, { ardia: "cli" }, "the pin's reservation holds while the v1 cli claims nothing itself");
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

test("the program registry lists the bundled claims and the pin's reservations and legacy installs, and refuses to lose a reservation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-registry-"));
  const plugin = (name, manifest) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "plugin.json"), JSON.stringify(manifest));
  };
  const LEGACY = [{ owner: "cli", program: "ardia", root: "Library/Application Support/Ardia/CLI", current: "current" }];
  plugin("cli", { manifest: 1, name: "cli", programs: [{ name: "ardia", path: "bin/ardia" }] });
  assert.deepEqual(JSON.parse(run(["registry", dir])), { version: 1, claims: { ardia: "cli" }, legacyInstalls: LEGACY }, "a v1 cli keeps ardia through the pin");
  plugin("cli", { manifest: 2, name: "cli", contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }, { name: "spare", path: "bin/spare", claim: true }] } });
  const both = JSON.parse(run(["registry", dir]));
  assert.deepEqual(both.claims, { ardia: "cli", spare: "cli" });
  run(["verify-registry", dir, JSON.stringify(both)]);
  assert.match(run(["verify-registry", dir, JSON.stringify({ ...both, claims: { spare: "cli" } })], { ok: false }), /lost the pin's reservation of ardia/);
  assert.match(run(["verify-registry", dir, JSON.stringify({ ...both, legacyInstalls: [] })], { ok: false }), /doesn't match/);
  plugin("cli", { manifest: 2, name: "cli", contributes: { programs: [{ name: "other", path: "bin/other" }] } });
  assert.match(run(["registry", dir], { ok: false }), /declares no such program/);
  const empty = mkdtempSync(join(tmpdir(), "ac-registry-empty-"));
  assert.match(run(["registry", empty], { ok: false }), /isn't bundled, so the registry would lose the reservation/);
  plugin("cli", { manifest: 2, name: "cli", contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
  plugin("copycat", { manifest: 2, name: "copycat", contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
  assert.match(run(["registry", dir], { ok: false }), /ardia is claimed by both/);
});

test("the pin's own fields are checked: preselected, anchor aliases and a legacy install under a known root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-pin-fields-"));
  const bad = (change) => {
    const pin = structuredClone(realPin);
    change(pin.plugins[0]);
    writeFileSync(join(dir, "pin.json"), JSON.stringify(pin));
    return run(["--pin", join(dir, "pin.json"), "check"], { ok: false });
  };
  assert.match(bad((p) => (p.preselected = "yes")), /preselected must be true/);
  assert.match(bad((p) => (p.anchorAliases = ["no spaces"])), /anchorAliases/);
  assert.match(bad((p) => (p.legacyInstall = { program: "ardia", root: "/etc", current: "current" })), /legacyInstall.root must be one of/);
  assert.match(bad((p) => (p.legacyInstall = { program: "ardia", root: "Library/Application Support/Ardia/CLI", current: "../x" })), /legacyInstall.current must be one file name/);
  assert.match(bad((p) => (p.legacyInstall = { program: "ardia" })), /legacyInstall must have program, root and current/);
  assert.match(bad((p) => (p.reservedPrograms = ["ardia", "ardia"])), /reservedPrograms must be a list of distinct program names/);
  assert.match(bad((p) => (p.example = "")), /example must be a command/);
  assert.match(bad((p) => (p.reservedPrograms = [])), /legacyInstall.program ardia must be one of its reservedPrograms/);
});
