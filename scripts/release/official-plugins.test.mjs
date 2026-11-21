import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MACHO = Buffer.concat([Buffer.from("cffaedfe0c000001", "hex"), Buffer.alloc(56)]);
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

function scratch({ pluginVersion = "0.3.0", link = false, programs = [{ name: "ardia", path: "bin/ardia" }], entitlements } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ac-pin-"));
  const artifacts = join(dir, "artifacts");
  mkdirSync(artifacts);
  tarball(artifacts, "cli-plugin-0.3.0-macos-arm64.tar.gz", "cli", { "plugin.json": JSON.stringify({ manifest: 1, name: "cli", version: pluginVersion, programs }), "bin/ardia": entitlements ? MACHO : "#!/bin/sh\necho ardia 0.3.0\n" }, link ? (top) => symlinkSync("/etc/passwd", join(top, "bin/evil")) : undefined);
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
    ...(entitlements && { entitlements }),
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

const JIT = "com.apple.security.cs.allow-jit";
const ARDIA_PROGRAM = [{ name: "ardia", path: "bin/ardia" }];

function pinWith(entitlements) {
  const dir = mkdtempSync(join(tmpdir(), "ac-pin-ents-"));
  const pin = structuredClone(realPin);
  pin.plugins[0].entitlements = entitlements;
  writeFileSync(join(dir, "pin.json"), JSON.stringify(pin));
  return join(dir, "pin.json");
}

function folderFor(plugin, manifest, files = { "bin/ardia": MACHO }) {
  const folder = join(mkdtempSync(join(tmpdir(), "ac-pin-folder-")), plugin.name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), body);
    chmodSync(join(folder, path), 0o755);
  }
  writeFileSync(join(folder, "plugin.json"), JSON.stringify({ manifest: 1, name: plugin.name, version: plugin.version, ...manifest }));
  return folder;
}

test("a pinned plugin's declared program gets exactly the entitlements the pin lists", () => {
  const { dir, artifacts, pin } = scratch({ programs: ARDIA_PROGRAM, entitlements: { "bin/ardia": [JIT] } });
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  assert.deepEqual(JSON.parse(readFileSync(pin, "utf8")).plugins[0].entitlements, { "bin/ardia": [JIT] });
  run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "plugins")]);
  assert.equal(run(["--pin", pin, "entitlements", "cli", join(dir, "plugins/cli")]), `bin/ardia\t${JIT}\n`);
  assert.equal(run(["--pin", pin, "entitlements", "unpinned", join(dir, "plugins/cli")]), "");
  assert.equal(run(["entitlements", "apple-passwords", join(dir, "plugins/cli")]), "");
});

test("the bundle is refused when the pin grants a path its plugin.json doesn't declare as a program", () => {
  const { dir, artifacts, pin } = scratch({ programs: [{ name: "ardia", path: "bin/other" }], entitlements: { "bin/ardia": [JIT] } });
  run(["--pin", pin, "--from", artifacts, "pin", "cli", "0.3.0"]);
  assert.match(run(["--pin", pin, "--from", artifacts, "bundle", join(dir, "plugins")], { ok: false }), /lists no program at that path/);
});

test("any other entitlement, a malformed path or a non-list is refused by check", () => {
  for (const [entitlements, message] of [
    [{ "bin/ardia": ["com.apple.security.cs.disable-library-validation"] }, /must list some of com\.apple\.security\.cs\.allow-jit/],
    [{ "bin/ardia": [JIT, JIT] }, /once each/],
    [{ "bin/ardia": [] }, /must list some of/],
    [{ "bin/ardia": JIT }, /must list some of/],
    [{ "../ardia": [JIT] }, /must be a program path/],
    [{ "/bin/ardia": [JIT] }, /must be a program path/],
    [{ "bin/./ardia": [JIT] }, /must be a program path/],
    [{ "bin//ardia": [JIT] }, /must be a program path/],
    [{ "bin/ardia\n": [JIT] }, /must be a program path/],
    [{ "lib/x.dylib": [JIT] }, /must be a program path/],
    [{}, /must map program paths/],
    [["bin/ardia"], /must map program paths/],
  ]) {
    assert.match(run(["--pin", pinWith(entitlements), "check"], { ok: false }), message, JSON.stringify(entitlements));
  }
});

test("a granted program that's a link, a hard link, not executable or not declared is refused", () => {
  const pin = pinWith({ "bin/ardia": [JIT] });
  const cli = realPin.plugins[0];
  assert.equal(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: ARDIA_PROGRAM })]), `bin/ardia\t${JIT}\n`);
  assert.match(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: [{ name: "other", path: "bin/other" }] }, { "bin/other": MACHO })], { ok: false }), /lists no program at that path/);
  assert.match(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: ARDIA_PROGRAM }, { "bin/ardia": "#!/bin/sh\n" })], { ok: false }), /isn't a Mach-O program/);
  assert.match(run(["--pin", pin, "entitlements", "cli", folderFor({ ...cli, version: "9.9.9" }, { programs: ARDIA_PROGRAM })], { ok: false }), /isn't the pinned cli/);
  const linked = folderFor(cli, { programs: ARDIA_PROGRAM }, { "real/ardia": MACHO });
  mkdirSync(join(linked, "bin"));
  symlinkSync("../real/ardia", join(linked, "bin/ardia"));
  assert.match(run(["--pin", pin, "entitlements", "cli", linked], { ok: false }), /a link, another case, or missing/);
  const linkedDir = folderFor(cli, { programs: ARDIA_PROGRAM }, { "real/ardia": MACHO });
  symlinkSync("real", join(linkedDir, "bin"));
  assert.match(run(["--pin", pin, "entitlements", "cli", linkedDir], { ok: false }), /a link, another case, or missing/);
  const hard = folderFor(cli, { programs: ARDIA_PROGRAM });
  linkSync(join(hard, "bin/ardia"), join(hard, "bin/twin"));
  assert.match(run(["--pin", pin, "entitlements", "cli", hard], { ok: false }), /no other links/);
  const plain = folderFor(cli, { programs: ARDIA_PROGRAM });
  chmodSync(join(plain, "bin/ardia"), 0o644);
  assert.match(run(["--pin", pin, "entitlements", "cli", plain], { ok: false }), /must be an executable/);
  assert.match(run(["--pin", pin, "entitlements", "cli", join(plain, "missing")], { ok: false }), /has no plugin\.json/);
  const otherCase = folderFor(cli, { programs: [{ name: "ardia", path: "bin/Ardia" }] });
  assert.match(run(["--pin", pinWith({ "bin/Ardia": [JIT] }), "entitlements", "cli", otherCase], { ok: false }), /another case/);
});

test("a grant is refused whenever Ardia would refuse the plugin's programs", () => {
  const pin = pinWith({ "bin/ardia": [JIT] });
  const cli = realPin.plugins[0];
  const ardia = { name: "ardia", path: "bin/ardia" };
  for (const [programs, message] of [
    [[{ path: "bin/ardia" }], /programs\[0\]\.name must be a plugin name/],
    [[{ name: "Bad Name", path: "bin/ardia" }], /programs\[0\]\.name must be a plugin name/],
    [[{ ...ardia, afterUpdate: 1 }], /programs\[0\]\.afterUpdate must be a list/],
    [[{ ...ardia, afterUpdate: [[]] }], /programs\[0\]\.afterUpdate must be a list/],
    [[{ ...ardia, afterUpdate: [["ok", ""]] }], /programs\[0\]\.afterUpdate must be a list/],
    [[{ ...ardia, afterUpdate: [["a"], ["b"], ["c"], ["d"], ["e"]] }], /programs\[0\]\.afterUpdate must be a list/],
    [[{ ...ardia, afterUpdate: [["x".repeat(1025)]] }], /programs\[0\]\.afterUpdate must be a list/],
    [[ardia, { name: "ardia", path: "bin/other" }], /two programs named ardia/],
    [[{ ...ardia, run: ["x"] }], /programs\[0\]\.run isn't a key/],
    [[ardia, { name: "two", path: "a\\b" }], /programs\[1\]\.path must be a file/],
    [[ardia, "bin/ardia"], /programs\[1\] must be an object/],
    [[ardia, ...["b", "c", "d", "e"].map((n) => ({ name: n, path: `bin/${n}` }))], /programs must be a list of at most 4/],
    [{ ardia }, /programs must be a list of at most 4/],
  ]) {
    assert.match(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs })], { ok: false }), message, JSON.stringify(programs));
  }
  assert.equal(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: [{ ...ardia, afterUpdate: [["bin/ardia", "setup"]] }] })]), `bin/ardia\t${JIT}\n`);
  const longUnicode = ["é".repeat(100)].concat(Array(5).fill("é".repeat(100))).join("/");
  assert.equal(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: [ardia, { name: "other", path: longUnicode }] })]), `bin/ardia\t${JIT}\n`);
  assert.match(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: [ardia, { name: "other", path: "é".repeat(1025) }] })], { ok: false }), /programs\[1\]\.path must be a file/);
  for (const manifest of [true, "1", 3, -1, 1.5, null]) {
    assert.match(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { manifest, programs: [ardia] })], { ok: false }), /which Ardia refuses/, String(manifest));
  }
  for (const body of ['"manifest": 1.0', '"manifest": 1e0', '"manifest": 0']) {
    const folder = folderFor(cli, { programs: [ardia] });
    writeFileSync(join(folder, "plugin.json"), `{${body}, "name": "cli", "version": "${cli.version}", "programs": [{"name": "ardia", "path": "bin/ardia"}]}`);
    assert.equal(run(["--pin", pin, "entitlements", "cli", folder]), `bin/ardia\t${JIT}\n`, body);
  }
  const v2 = (contributes, extra = {}) => folderFor(cli, { manifest: 2, contributes, ...extra });
  assert.equal(run(["--pin", pin, "entitlements", "cli", v2({ programs: [{ ...ardia, claim: true, example: "ardia browse" }] })]), `bin/ardia\t${JIT}\n`);
  for (const [folder, message] of [
    [folderFor(cli, { manifest: 2, programs: [ardia] }), /programs isn't a key of a plugin/],
    [v2({ programs: [ardia] }, { programs: [ardia] }), /programs isn't a key of a plugin/],
    [v2([]), /contributes must be an object/],
    [v2({ programs: [{ name: "other", path: "bin/other" }] }), /lists no program at that path/],
    [v2({ programs: [{ ...ardia, claim: "yes" }] }), /claim must be true or false/],
    [v2({ programs: [{ ...ardia, example: "" }] }), /example must be text/],
    [v2({ programs: [{ ...ardia, example: "\ufeff " }] }), /example must be text/],
    [v2({ programs: [{ ...ardia, example: "x".repeat(121) }] }), /example must be text/],
    [v2({ programs: [{ ...ardia, example: "ardia \u202e" }] }), /example must be text/],
    [folderFor(cli, { programs: [{ ...ardia, claim: true }] }), /claim needs manifest 2/],
    [folderFor(cli, { programs: [{ ...ardia, example: "ardia" }] }), /example needs manifest 2/],
    [folderFor(cli, { manifest: 1, main: "main.js", programs: [ardia] }), /programs isn't a key of a plugin/],
  ]) {
    assert.match(run(["--pin", pin, "entitlements", "cli", folder], { ok: false }), message, String(message));
  }
  assert.equal(run(["--pin", pin, "entitlements", "cli", folderFor(cli, { programs: [{ ...ardia, claim: false }] })]), `bin/ardia\t${JIT}\n`);
  const unmanifested = folderFor(cli, { programs: [ardia] });
  writeFileSync(join(unmanifested, "plugin.json"), JSON.stringify({ name: "cli", version: cli.version, programs: [ardia] }));
  assert.equal(run(["--pin", pin, "entitlements", "cli", unmanifested]), `bin/ardia\t${JIT}\n`);
});

test("machos lists every Mach-O by its magic, whatever its name or mode, and nothing else", () => {
  const folder = mkdtempSync(join(tmpdir(), "ac-pin-machos-"));
  const fat = (order, count) => { const b = Buffer.alloc(64); b.write(order === "big" ? "cafebabe" : "bebafeca", 0, "hex"); order === "big" ? b.writeUInt32BE(count, 4) : b.writeUInt32LE(count, 4); return b; };
  const files = {
    "bin/thin64": [Buffer.from("cffaedfe", "hex"), 0o755],
    "lib/data-0644-fat": [fat("big", 2), 0o644],
    "lib/swapped-fat": [fat("little", 2), 0o600],
    "lib/thin32": [Buffer.from("cefaedfe", "hex"), 0o644],
    "lib/thin32-be": [Buffer.from("feedface", "hex"), 0o644],
    "lib/thin64-be": [Buffer.from("feedfacf", "hex"), 0o644],
    "lib/fat64": [Buffer.concat([Buffer.from("cafebabf00000002", "hex"), Buffer.alloc(8)]), 0o644],
    "lib/empty-fat": [fat("big", 0), 0o644],
    "bin/script": [Buffer.from("#!/bin/sh\n"), 0o755],
    "short": [Buffer.from("cffa", "hex"), 0o644],
  };
  for (const [path, [body, mode]] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), body);
    chmodSync(join(folder, path), mode);
  }
  symlinkSync("thin64", join(folder, "bin/link-to-macho"));
  const listed = run(["machos", folder]).split("\0").filter(Boolean).map((p) => p.slice(folder.length + 1));
  assert.deepEqual(listed, ["bin/thin64", "lib/data-0644-fat", "lib/fat64", "lib/swapped-fat", "lib/thin32", "lib/thin32-be", "lib/thin64-be"]);
  writeFileSync(join(folder, "lib/fat31"), fat("big", 31));
  assert.match(run(["machos", folder], { ok: false }), /claiming 31 architectures/);
  rmSync(join(folder, "lib/fat31"));
  writeFileSync(join(folder, "lib/Java.class"), Buffer.concat([Buffer.from("cafebabe00000037", "hex"), Buffer.alloc(8)]));
  assert.match(run(["machos", folder], { ok: false }), /claiming 55 architectures \(or a Java class file\)/);
  assert.match(run(["machos", join(folder, "missing")], { ok: false }), /isn't a folder/);
  symlinkSync(folder, `${folder}-link`);
  assert.match(run(["machos", `${folder}-link/`], { ok: false }), /isn't a folder/);
});
