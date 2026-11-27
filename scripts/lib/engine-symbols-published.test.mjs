import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const check = new URL("./engine-symbols-published.sh", import.meta.url).pathname;
const FRAMEWORK_UUID = "4c4c440c-5555-3144-a131-0f7dd4b879a1";
const OTHER_UUID = "4c4c4449-5555-3144-a17c-2ebff056d510";

const stubs = {
  gh: `#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
case "$1 $2" in
  "release view")
    dir="$STUB_RELEASES/$3"
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    for file in "$dir"/*; do [ -e "$file" ] && printf '%s\\t%s\\n' "$(basename "$file")" "$(wc -c <"$file" | tr -d ' ')"; done
    ;;
  "release download")
    tag="$3"; shift 3
    pattern="" dir=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) pattern="$2"; shift ;; -D) dir="$2"; shift ;; esac
      shift
    done
    [ -f "$STUB_RELEASES/$tag/$pattern" ] || { echo "release asset not found" >&2; exit 1; }
    cp "$STUB_RELEASES/$tag/$pattern" "$dir/$pattern"
    ;;
  *) echo "unexpected: gh $*" >&2; exit 2 ;;
esac
`,
  dwarfdump: `#!/usr/bin/env bash
[ "$1" = "--uuid" ] || exit 2
read -r uuid arch kind names data <"$2"
echo "UUID: $(echo "\${uuid#uuid:}" | tr 'a-f' 'A-F') ($arch) $2"
`,
  otool: `#!/usr/bin/env bash
read -r uuid arch kind names data <"\${@: -1}"
echo "Mach header"
echo "      magic  cputype cpusubtype  caps    filetype ncmds sizeofcmds      flags"
echo "MH_MAGIC_64    ARM64        ALL  0x00        \${kind:-DYLIB}     9       4344 0x00000000"
`,
  nm: `#!/usr/bin/env bash
read -r uuid arch kind names data <"\${@: -1}"
for ((i = 0; i < \${data:-0}; i++)); do echo "0000000000002000 d _data$i"; done
for ((i = 0; i < \${names:-0}; i++)); do echo "0000000000001000 t _f$i"; done
`,
};

let work, env, framework;

const release = (tag, assets) => {
  const dir = join(work, "releases", tag);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, name), body);
};

const run = (tag) => spawnSync("bash", [check, tag, framework], { env, encoding: "utf8" });

before(() => {
  work = mkdtempSync(join(tmpdir(), "engine-symbols-published-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  framework = join(work, "Chromium Framework.framework");
  mkdirSync(join(framework, "Versions/Current"), { recursive: true });
  writeFileSync(join(framework, "Versions/Current/Chromium Framework"), `uuid:${FRAMEWORK_UUID} arm64\n`);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(work, "gh.log"), STUB_RELEASES: join(work, "releases") };
  const dwarf = "Chromium Framework.dSYM/Contents/Resources/DWARF/Chromium Framework";
  const archive = (uuid, kind = "DSYM", names = 100001, data = 0) => {
    const dir = mkdtempSync(join(work, "dsym-"));
    mkdirSync(join(dir, "Chromium Framework.dSYM/Contents/Resources/DWARF"), { recursive: true });
    writeFileSync(join(dir, dwarf), `uuid:${uuid} arm64 ${kind} ${names} ${data}\n`);
    execFileSync("tar", ["-cJf", join(dir, "out.tar.xz"), "-C", dir, "Chromium Framework.dSYM"]);
    return readFileSync(join(dir, "out.tar.xz"));
  };
  release("engine-aaaaaaaaaaaa", {
    "ArdiaCore-aaaaaaaaaaaa.tar.xz": "engine",
    "ArdiaCore-aaaaaaaaaaaa-symbols.tar.xz": archive(FRAMEWORK_UUID),
    "ArdiaCore-aaaaaaaaaaaa-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-bbbbbbbbbbbb", { "ArdiaCore-bbbbbbbbbbbb.tar.xz": "engine" });
  release("engine-cccccccccccc", {
    "ArdiaCore-cccccccccccc-symbols.tar.xz": archive(OTHER_UUID),
    "ArdiaCore-cccccccccccc-uuids.txt": `${OTHER_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-dddddddddddd", {
    "ArdiaCore-dddddddddddd-symbols.tar.xz": "",
    "ArdiaCore-dddddddddddd-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-ffffffffffff", {
    "ArdiaCore-ffffffffffff-symbols.tar.xz": archive(FRAMEWORK_UUID),
    "ArdiaCore-ffffffffffff-uuids.txt": `${FRAMEWORK_UUID}\tarm64\n`,
  });
  release("engine-222222222222", {
    "ArdiaCore-222222222222-symbols.tar.xz": archive(FRAMEWORK_UUID, "DYLIB", 2791),
    "ArdiaCore-222222222222-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-333333333333", {
    "ArdiaCore-333333333333-symbols.tar.xz": archive(FRAMEWORK_UUID, "DSYM", 2791),
    "ArdiaCore-333333333333-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-444444444444", {
    "ArdiaCore-444444444444-symbols.tar.xz": archive(FRAMEWORK_UUID, "DSYM", 1, 100010),
    "ArdiaCore-444444444444-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
  release("engine-111111111111", {
    "ArdiaCore-111111111111-symbols.tar.xz": archive(OTHER_UUID),
    "ArdiaCore-111111111111-uuids.txt": `${FRAMEWORK_UUID}\tarm64\t${dwarf}\n`,
  });
});

after(() => rmSync(work, { recursive: true, force: true }));

test("an engine release whose uuids list names the framework's UUID passes", () => {
  const result = run("engine-aaaaaaaaaaaa");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`names Chromium Framework ${FRAMEWORK_UUID} \\(arm64\\) with Chromium Framework\\.dSYM`));
});

test("an engine release with no symbols fails and says how to publish them", () => {
  const result = run("engine-bbbbbbbbbbbb");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no ArdiaCore-bbbbbbbbbbbb-symbols\.tar\.xz/);
});

test("symbols from another build of the engine fail: they can't name this framework's frames", () => {
  const result = run("engine-cccccccccccc");
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`doesn't list Chromium Framework ${FRAMEWORK_UUID} \\(arm64\\)`));
});

test("a uuids row without a DWARF file fails: symbolicate-crash.sh would have nothing to hand atos", () => {
  const result = run("engine-ffffffffffff");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /with a DWARF file/);
});

test("an archive whose DWARF file is from another build fails, even when the uuids list names this one", () => {
  const result = run("engine-111111111111");
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`has UUID ${OTHER_UUID} for arm64, not ${FRAMEWORK_UUID}`));
});

test("the stripped framework packed as its own dSYM fails: it has the UUID but names no frames", () => {
  const stripped = run("engine-222222222222");
  assert.equal(stripped.status, 1);
  assert.match(stripped.stderr, /is a DYLIB file, not a dSYM/);
  const thin = run("engine-333333333333");
  assert.equal(thin.status, 1);
  assert.match(thin.stderr, /names 100000 functions or fewer/);
});

test("a dSYM full of data symbols but stripped of its functions fails: only function names name frames", () => {
  const result = run("engine-444444444444");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /names 100000 functions or fewer/);
});

test("an empty symbols archive fails", () => {
  const result = run("engine-dddddddddddd");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbols\.tar\.xz is empty/);
});

test("an unpublished release, a non-engine tag and a missing framework fail before anything is downloaded", () => {
  assert.equal(run("engine-eeeeeeeeeeee").status, 1);
  const app = run("v0.2.48");
  assert.equal(app.status, 1);
  assert.match(app.stderr, /isn't an engine release tag/);
  const missing = spawnSync("bash", [check, "engine-aaaaaaaaaaaa", join(work, "nowhere.framework")], { env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no Chromium Framework/);
});
