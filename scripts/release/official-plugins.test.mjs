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
  const out = run(["--pin", pin, "--from", artifacts, "fetch", "cli", "macos-arm64", join(dir, "cli.tar.gz")], { ok: false });
  assert.match(out, /has no SHA-256 for cli-plugin-0\.3\.0-macos-arm64\.tar\.gz: publish it from its repo, then run official-plugins\.py pin cli 0\.3\.0/);
});

test("pinned and verified: the local copy the release smoke installs from, and the pin Info.plist carries", () => {
  const { dir, artifacts, pin } = scratch();
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  const pinned = JSON.parse(readFileSync(pin, "utf8")).plugins[0];
  assert.match(pinned.artifacts["macos-arm64"].sha256, /^[0-9a-f]{64}$/);
  assert.equal(pinned.release, "https://github.com/ardia-browser/plugins/releases/download/cli-v0.3.0");
  run(["--pin", pin, "--from", artifacts, "fixtures", join(dir, "fixtures")]);
  assert.deepEqual(readdirSync(join(dir, "fixtures")), ["cli-plugin-0.3.0-macos-arm64.tar.gz"]);
  const signed = JSON.parse(run(["--pin", pin, "signed-pin"]));
  assert.deepEqual(signed.plugins[0].artifacts["macos-arm64"], pinned.artifacts["macos-arm64"]);
  const half = structuredClone(JSON.parse(readFileSync(pin, "utf8")));
  half.plugins[0].artifacts["linux-x64"].sha256 = null;
  writeFileSync(pin, JSON.stringify(half));
  assert.equal(JSON.parse(run(["--pin", pin, "signed-pin"])).plugins[0].artifacts["linux-x64"], undefined, "Info.plist holds no null: an unpublished artifact is left out");
});

test("a changed artifact is refused", () => {
  const changed = scratch();
  run(["--pin", changed.pin, "--from", changed.artifacts, "pin", "cli", "0.3.0"]);
  writeFileSync(join(changed.artifacts, "cli-plugin-0.3.0-macos-arm64.tar.gz"), "swapped");
  assert.match(run(["--pin", changed.pin, "--from", changed.artifacts, "fixtures", join(changed.dir, "fixtures")], { ok: false }), /not the pinned/);
  assert.equal(existsSync(join(changed.dir, "fixtures", "cli-plugin-0.3.0-macos-arm64.tar.gz")), false);
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

test("the program registry is the pin's reservations and legacy installs, with or without anything installed", () => {
  const LEGACY = [{ owner: "cli", program: "ardia", root: "Library/Application Support/Ardia/CLI", current: "current" }];
  const registry = JSON.parse(run(["registry"]));
  assert.deepEqual(registry, { version: 1, claims: { ardia: "cli" }, legacyInstalls: LEGACY });
  run(["verify-registry", JSON.stringify(registry)]);
  assert.match(run(["verify-registry", JSON.stringify({ ...registry, claims: {} })], { ok: false }), /lost the pin's reservation of ardia/);
  assert.match(run(["verify-registry", JSON.stringify({ ...registry, legacyInstalls: [] })], { ok: false }), /doesn't match/);
  const dir = mkdtempSync(join(tmpdir(), "ac-registry-"));
  const unpublished = structuredClone(realPin);
  for (const plugin of unpublished.plugins) plugin.artifacts["macos-arm64"] = { file: plugin.artifacts["macos-arm64"]?.file ?? "x.tar.gz", sha256: null };
  writeFileSync(join(dir, "pin.json"), JSON.stringify(unpublished));
  assert.deepEqual(JSON.parse(run(["--pin", join(dir, "pin.json"), "registry"])), { version: 1, claims: {}, legacyInstalls: [] }, "the app derives the same from a pin with nothing published");
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

const historyFile = join(root, "apps/browser/official-plugins-history.json");
const hasTags = spawnSync("git", ["-C", root, "tag", "-l", "v*"], { encoding: "utf8" }).stdout.trim().length > 0;

test("the signed pin carries each plugin's earlier pinned artifacts and shipped bundled digests from the history", () => {
  const signed = JSON.parse(run(["signed-pin"]));
  const history = JSON.parse(readFileSync(historyFile, "utf8"));
  for (const plugin of signed.plugins) {
    const entries = history.plugins[plugin.name] ?? [];
    if (!entries.length) continue;
    assert.deepEqual(plugin.trusted.artifacts, [...new Set(entries.map((e) => e.artifact))].sort());
    assert.deepEqual(plugin.trusted.bundledDigests, [...new Set(entries.filter((e) => e.bundledDigest).map((e) => e.bundledDigest))].sort());
  }
  assert.ok(signed.plugins.find((p) => p.name === "cli").trusted.bundledDigests.length >= 1, "0.2.47's kept Command Line is covered");
});

test("the history lists every release tag that pinned an official plugin still in the pin", { skip: !hasTags && "no v* tags in this clone" }, () => {
  assert.match(run(["history-check"]), /cover every pinned release tag/);
});

test("a history missing a pinned release fails the check, and a malformed one is refused", { skip: !hasTags && "no v* tags in this clone" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-history-"));
  const history = JSON.parse(readFileSync(historyFile, "utf8"));
  const short = { ...history, plugins: { cli: history.plugins.cli.slice(1) } };
  writeFileSync(join(dir, "short.json"), JSON.stringify(short));
  assert.match(run(["--history", join(dir, "short.json"), "history-check"], { ok: false }), /behind the release tags/);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ version: 1, plugins: { cli: [{ release: "v0.0.1", version: "0.0.1", artifact: "nope" }] } }));
  assert.match(run(["--history", join(dir, "bad.json"), "signed-pin"], { ok: false }), /artifact must be a SHA-256/);
});
