import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";

const scripts = new URL(".", import.meta.url).pathname;
const symbolicate = join(scripts, "symbolicate-crash.sh");
const packSymbols = join(scripts, "lib/pack-symbols.sh");

const FRAMEWORK_UUID = "4c4c44f3-5555-3144-a138-48cce2a582ef";
const NEWER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LIBRARY_UUID = "11111111-2222-3333-4444-555555555555";

const stubs = {
  gh: `#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
case "$1 $2" in
  "api repos/"*)
    page="\${2##*page=}"
    [ "$3" = "--jq" ] || { echo "expected --jq" >&2; exit 2; }
    jq -r "$4" "$STUB_RELEASES/page-$page.json" 2>/dev/null || echo "[]" | jq -r "$4"
    ;;
  "release download")
    tag="$3"; shift 3
    pattern="" dir=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) pattern="$2"; shift ;; -D) dir="$2"; shift ;; esac
      shift
    done
    [ -f "$STUB_ASSETS/$tag/$pattern" ] || { echo "release asset not found" >&2; exit 1; }
    [ -z "\${STUB_SLOW:-}" ] || perl -e 'select(undef, undef, undef, $ENV{STUB_SLOW})'
    cp "$STUB_ASSETS/$tag/$pattern" "$dir/$pattern.part"
    [ -z "\${STUB_SLOW:-}" ] || perl -e 'select(undef, undef, undef, $ENV{STUB_SLOW})'
    mv "$dir/$pattern.part" "$dir/$pattern"
    ;;
  *) echo "unexpected: gh $*" >&2; exit 2 ;;
esac
`,
  dwarfdump: `#!/usr/bin/env bash
[ "$1" = "--uuid" ] || exit 2
id="$(sed -n 's/^uuid://p' "$2")"
[ -n "$id" ] || { echo "not a Mach-O file" >&2; exit 1; }
echo "UUID: $(echo "$id" | tr 'a-f' 'A-F') (arm64) $2"
`,
  atos: `#!/usr/bin/env bash
echo "atos $*" >>"$STUB_LOG"
shift 6
for address in "$@"; do
  case "$address" in
    0x0) echo "$address" ;;
    *) echo "frame_$address (in Chromium Framework) (stub.cc:1)" ;;
  esac
done
`,
};

let work, bin, assets, cache, env;

const writeImage = (dir, rel, uuid) => {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `uuid:${uuid}\nnot a real binary\n`);
  chmodSync(path, 0o755);
};

const dwarfOf = (rel) => `${basename(rel)}.dSYM/Contents/Resources/DWARF/${basename(rel)}`;

const makeBuild = (name, images, dsymUuids = images) => {
  const out = join(work, `out-${name}`);
  const framework = join(out, "Chromium Framework.framework");
  for (const [rel, uuid] of Object.entries(images)) writeImage(join(framework, "Versions/A"), rel, uuid);
  writeFileSync(join(framework, "Versions/A/install.sh"), "#!/bin/sh\n");
  chmodSync(join(framework, "Versions/A/install.sh"), 0o755);
  symlinkSync("A", join(framework, "Versions/Current"));
  for (const [rel, uuid] of Object.entries(dsymUuids)) {
    if (uuid) writeImage(out, dwarfOf(rel), uuid);
  }
  return { framework, dsyms: out };
};

const run = (script, args, extra = {}) =>
  spawnSync(script, args, { encoding: "utf8", env: { ...env, ...extra } });

const publish = (tag, images) => {
  const { framework, dsyms } = makeBuild(tag, images);
  const short = tag.replace(/^engine-/, "");
  const dir = join(assets, tag);
  mkdirSync(dir, { recursive: true });
  const packed = run(packSymbols, [framework, dsyms, join(dir, `ArdiaCore-${short}-symbols.tar.xz`), join(dir, `ArdiaCore-${short}-uuids.txt`)]);
  assert.equal(packed.status, 0, packed.stderr);
  return dir;
};

const FRAMEWORK_DWARF = dwarfOf("Chromium Framework");

const downloads = (pattern) =>
  readFileSync(env.STUB_LOG, "utf8").split("\n").filter((line) => line.startsWith("gh release download") && line.includes(pattern));

before(() => {
  work = mkdtempSync(join(tmpdir(), "symbolicate-test-"));
  bin = join(work, "bin");
  assets = join(work, "assets");
  cache = join(work, "cache");
  mkdirSync(bin);
  for (const [name, source] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: join(work, "stub.log"),
    STUB_ASSETS: assets,
    STUB_RELEASES: join(work, "releases"),
  };
  writeFileSync(env.STUB_LOG, "");
  mkdirSync(env.STUB_RELEASES);
  const release = (tag) => ({ tag_name: tag, assets: (existsSync(join(assets, tag)) ? readdirSync(join(assets, tag)) : []).map((name) => ({ name })) });
  const apps = (from, count) => Array.from({ length: count }, (_, i) => `v0.${from + i}.0-nightly.1`);
  publish("engine-bbbbbbbbbbbb", { "Chromium Framework": NEWER_UUID });
  publish("engine-aaaaaaaaaaaa", {
    "Chromium Framework": FRAMEWORK_UUID,
    "Libraries/libfoo.dylib": LIBRARY_UUID,
    "Helpers/chrome_crashpad_handler": "99999999-8888-7777-6666-555555555555",
  });
  const mismatched = publish("engine-dddddddddddd", { "Chromium Framework": "dddddddd-dddd-dddd-dddd-dddddddddddd" });
  cpSync(join(assets, "engine-aaaaaaaaaaaa/ArdiaCore-aaaaaaaaaaaa-symbols.tar.xz"), join(mismatched, "ArdiaCore-dddddddddddd-symbols.tar.xz"));
  const pages = [
    ["engine-bbbbbbbbbbbb", "v0.2.43", "engine-cccccccccccc", ...apps(0, 97)],
    apps(100, 100),
    [...apps(200, 99), "engine-aaaaaaaaaaaa"],
  ];
  pages.forEach((tags, i) => writeFileSync(join(env.STUB_RELEASES, `page-${i + 1}.json`), JSON.stringify(tags.map(release))));
});

after(() => rmSync(work, { recursive: true, force: true }));

test("pack-symbols names each image's dSYM by UUID and packs those dSYMs", () => {
  const dir = join(assets, "engine-aaaaaaaaaaaa");
  const rows = readFileSync(join(dir, "ArdiaCore-aaaaaaaaaaaa-uuids.txt"), "utf8").trimEnd().split("\n");
  assert.deepEqual(rows, [
    `${FRAMEWORK_UUID}\tarm64\t${FRAMEWORK_DWARF}`,
    `99999999-8888-7777-6666-555555555555\tarm64\t${dwarfOf("Helpers/chrome_crashpad_handler")}`,
    `${LIBRARY_UUID}\tarm64\t${dwarfOf("Libraries/libfoo.dylib")}`,
  ]);
  const members = execFileSync("tar", ["-tJf", join(dir, "ArdiaCore-aaaaaaaaaaaa-symbols.tar.xz")], { encoding: "utf8" }).trimEnd().split("\n");
  for (const rel of ["Chromium Framework", "Helpers/chrome_crashpad_handler", "Libraries/libfoo.dylib"]) assert.ok(members.includes(dwarfOf(rel)), members.join("\n"));
  assert.ok(members.every((m) => m.split("/")[0].endsWith(".dSYM")), members.join("\n"));
});

test("pack-symbols refuses a framework whose own dSYM is missing or from another build, and warns about a helper's", () => {
  const images = { "Chromium Framework": FRAMEWORK_UUID, "Helpers/chrome_crashpad_handler": "99999999-8888-7777-6666-555555555555" };
  const stale = makeBuild("stale", images, { "Chromium Framework": NEWER_UUID, "Helpers/chrome_crashpad_handler": images["Helpers/chrome_crashpad_handler"] });
  const refused = run(packSymbols, [stale.framework, stale.dsyms, join(work, "s.tar.xz"), join(work, "s.txt")]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`no dSYM in .* holds Chromium Framework's UUID ${FRAMEWORK_UUID} \\(arm64\\)`));
  assert.equal(existsSync(join(work, "s.txt")), false);
  assert.equal(existsSync(join(work, "s.tar.xz")), false);

  const partial = makeBuild("partial", images, { "Chromium Framework": FRAMEWORK_UUID });
  const packed = run(packSymbols, [partial.framework, partial.dsyms, join(work, "p.tar.xz"), join(work, "p.txt")]);
  assert.equal(packed.status, 0, packed.stderr);
  assert.match(packed.stderr, /no dSYM for Helpers\/chrome_crashpad_handler/);
  assert.equal(readFileSync(join(work, "p.txt"), "utf8"), `${FRAMEWORK_UUID}\tarm64\t${FRAMEWORK_DWARF}\n`);

  const nothing = run(packSymbols, [join(work, "nowhere.framework"), partial.dsyms, join(work, "n.tar.xz"), join(work, "n.txt")]);
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /no framework at/);
});

test("a crash's image UUID and offsets resolve through the engine release that holds them, past the first pages of releases", () => {
  const result = run(symbolicate, ["--cache", cache, FRAMEWORK_UUID.toUpperCase(), "0x2e2334", "+0x3cae9d8"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "0x2e2334\tframe_0x2e2334 (in Chromium Framework) (stub.cc:1)\n0x3cae9d8\tframe_0x3cae9d8 (in Chromium Framework) (stub.cc:1)\n",
  );
  assert.match(result.stderr, new RegExp(`DWARF/Chromium Framework \\(${FRAMEWORK_UUID}, arm64\\) from engine-aaaaaaaaaaaa`));
  const log = readFileSync(env.STUB_LOG, "utf8");
  assert.ok(log.includes(`atos -arch arm64 -o ${join(cache, "engine-aaaaaaaaaaaa/symbols", FRAMEWORK_DWARF)} -l 0x0 0x2e2334 0x3cae9d8\n`), log);
  assert.equal(downloads("-symbols.tar.xz").length, 1);
  assert.deepEqual(downloads("-uuids.txt").map((line) => line.split(" ")[3]), ["engine-bbbbbbbbbbbb", "engine-aaaaaaaaaaaa"]);
  assert.deepEqual(readFileSync(env.STUB_LOG, "utf8").match(/&page=\d+/g), ["&page=1", "&page=2", "&page=3"]);
  assert.deepEqual(readdirSync(cache).filter((name) => name.startsWith(".run")), []);
});

test("a second run reuses the downloaded symbols, and finds other images of the same engine", () => {
  const before = downloads("-symbols.tar.xz").length;
  const again = run(symbolicate, ["--cache", cache, FRAMEWORK_UUID, "0xda7240"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(downloads("-symbols.tar.xz").length, before);

  const library = run(symbolicate, ["--cache", cache, LIBRARY_UUID, "0x10"]);
  assert.equal(library.status, 0, library.stderr);
  assert.match(library.stderr, /DWARF\/libfoo\.dylib .* from engine-aaaaaaaaaaaa/);
  assert.equal(downloads("-symbols.tar.xz").length, before + 1);
});

const runAsync = (args, extra) =>
  new Promise((resolve) => {
    const child = spawn(symbolicate, args, { env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("concurrent runs on one cache each download and unpack their own copy", async () => {
  const shared = join(work, "cache-concurrent");
  const helper = "99999999-8888-7777-6666-555555555555";
  const results = await Promise.all(
    [FRAMEWORK_UUID, LIBRARY_UUID, helper, FRAMEWORK_UUID].map((id) => runAsync(["--tag", "engine-aaaaaaaaaaaa", "--cache", shared, id, "0x10"], { STUB_SLOW: "0.3" })),
  );
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.match(results[1].stderr, /libfoo\.dylib/);
  assert.match(results[2].stderr, /chrome_crashpad_handler/);
  for (const rel of ["Chromium Framework", "Libraries/libfoo.dylib", "Helpers/chrome_crashpad_handler"]) {
    assert.ok(existsSync(join(shared, "engine-aaaaaaaaaaaa/symbols", dwarfOf(rel))), rel);
  }
  assert.deepEqual(readdirSync(shared).filter((name) => name.startsWith(".run")), []);
  assert.deepEqual(readdirSync(join(shared, "engine-aaaaaaaaaaaa")).sort(), ["ArdiaCore-aaaaaaaaaaaa-uuids.txt", "symbols"]);
});

test("--tag goes straight to one engine release", () => {
  const cold = join(work, "cache-tag");
  const logged = readFileSync(env.STUB_LOG, "utf8").length;
  const result = run(symbolicate, ["--tag", "engine-bbbbbbbbbbbb", "--cache", cold, NEWER_UUID, "0x54cc"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /from engine-bbbbbbbbbbbb/);
  assert.doesNotMatch(readFileSync(env.STUB_LOG, "utf8").slice(logged), /gh api/);

  const wrong = run(symbolicate, ["--tag", "engine-bbbbbbbbbbbb", "--cache", cold, FRAMEWORK_UUID, "0x54cc"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /engine-bbbbbbbbbbbb's symbols don't list the image/);

  const none = run(symbolicate, ["--tag", "engine-cccccccccccc", "--cache", cold, FRAMEWORK_UUID, "0x54cc"]);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /engine-cccccccccccc has no ArdiaCore-cccccccccccc-uuids\.txt/);
});

test("an offset atos cannot name is reported, not hidden", () => {
  const result = run(symbolicate, ["--cache", cache, FRAMEWORK_UUID, "0x0", "0x8502c6c"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^0x0\t0x0\n0x8502c6c\tframe_0x8502c6c/);
  assert.match(result.stderr, /atos couldn't name 1 of 2 offsets in Chromium Framework/);
});

test("an image no engine release lists is an error that says so", () => {
  const result = run(symbolicate, ["--cache", cache, "00000000-0000-0000-0000-000000000000", "0x1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no engine release lists the image 00000000-0000-0000-0000-000000000000/);
});

test("symbols that don't hold the UUID their release lists are refused", () => {
  writeFileSync(
    join(assets, "engine-dddddddddddd/ArdiaCore-dddddddddddd-uuids.txt"),
    `dddddddd-dddd-dddd-dddd-dddddddddddd\tarm64\t${FRAMEWORK_DWARF}\n`,
  );
  const result = run(symbolicate, ["--tag", "engine-dddddddddddd", "--cache", join(work, "cache-mismatch"), "dddddddd-dddd-dddd-dddd-dddddddddddd", "0x1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`DWARF/Chromium Framework in engine-dddddddddddd has UUID ${FRAMEWORK_UUID}, not dddddddd-dddd-dddd-dddd-dddddddddddd`));
});

test("it rejects a malformed UUID or offset before calling anything", () => {
  const size = readFileSync(env.STUB_LOG, "utf8").length;
  const uuid = run(symbolicate, ["--cache", cache, "4c4c44f3", "0x1"]);
  assert.notEqual(uuid.status, 0);
  assert.match(uuid.stderr, /isn't an image UUID/);
  const offset = run(symbolicate, ["--cache", cache, FRAMEWORK_UUID, "2e2334"]);
  assert.notEqual(offset.status, 0);
  assert.match(offset.stderr, /isn't a hex offset/);
  const missing = run(symbolicate, [FRAMEWORK_UUID]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage: scripts\/symbolicate-crash\.sh/);
  assert.equal(readFileSync(env.STUB_LOG, "utf8").length, size);
});

test("--help prints the header", () => {
  const result = run(symbolicate, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Names the frames of a native crash/);
  assert.match(result.stdout, /scripts\/symbolicate-crash\.sh \[--tag <engine-tag>\]/);
});

test("publish-engine.sh copies the dSYMs with the framework, packs them before stripping and uploads them", () => {
  const source = readFileSync(join(scripts, "publish-engine.sh"), "utf8");
  const copy = source.indexOf('"$framework" "$work/Ardia.app/Contents/Frameworks/" "$(dirname "$framework")" "$out/dsyms")');
  const locked = source.indexOf('locked" chromium --wait 500 -- "${copy[@]}"');
  const pack = source.indexOf('pack-symbols.sh" "$work/Ardia.app/Contents/Frameworks/Chromium Framework.framework" "$out/dsyms" "$symbols_archive" "$uuids_file"');
  const strip = source.indexOf('strip-engine.sh" "$work/Ardia.app" "$out/symbols"');
  assert.ok(copy > 0 && locked > copy, "the dSYMs are copied in the same locked command as the framework");
  assert.ok(pack > locked && strip > pack, "pack-symbols.sh runs on the copies, before strip-engine.sh");
  assert.match(source, /^symbols_archive="\$out\/\$\(engine_symbols_name "\$tag"\)"$/m);
  assert.match(source, /^uuids_file="\$out\/\$\(engine_uuids_name "\$tag"\)"$/m);
  assert.match(source, /^assets=\("\$archive" "\$archive\.sha256" "\$symbols_archive" "\$uuids_file" "\$source_archive"\)$/m);
  assert.match(source, /^run gh release upload "\$tag" -R "\$REPO" --clobber "\$\{assets\[@\]\}"$/m);
});

test("the release names the symbolicate script looks for are the ones publish-engine.sh uploads", () => {
  const names = execFileSync("bash", ["-c", `. "${join(scripts, "lib/releases.sh")}"; engine_symbols_name engine-4f3a9c0d1e2b; engine_uuids_name engine-4f3a9c0d1e2b`], {
    encoding: "utf8",
  }).trimEnd().split("\n");
  assert.deepEqual(names, ["ArdiaCore-4f3a9c0d1e2b-symbols.tar.xz", "ArdiaCore-4f3a9c0d1e2b-uuids.txt"]);
});

const asBash = (script, extra = {}) => spawnSync("bash", ["-c", `set -euo pipefail; . "${join(scripts, "lib/releases.sh")}"; ${script}; echo reached`], { encoding: "utf8", env: { ...env, ...extra } });

test("publish-engine.sh stops unless the symbols archive and the UUID list exist and are not empty", () => {
  const dir = join(work, "guard");
  mkdirSync(dir, { recursive: true });
  const symbols = join(dir, "ArdiaCore-cccccccccccc-symbols.tar.xz");
  const uuids = join(dir, "ArdiaCore-cccccccccccc-uuids.txt");
  const check = `require_symbol_assets "${symbols}" "${uuids}"`;
  rmSync(symbols, { force: true });
  rmSync(uuids, { force: true });
  const neither = asBash(check);
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /ArdiaCore-cccccccccccc-symbols\.tar\.xz is missing or empty/);
  assert.equal(neither.stdout, "");
  writeFileSync(symbols, "archive");
  const noUuids = asBash(check);
  assert.equal(noUuids.status, 1);
  assert.match(noUuids.stderr, /ArdiaCore-cccccccccccc-uuids\.txt is missing or empty/);
  writeFileSync(uuids, "");
  assert.equal(asBash(check).status, 1, "an empty UUID list is as good as none");
  writeFileSync(uuids, "4c4c44af-5555-3144-a1d1-8e024e2486d8\tarm64\tChromium Framework.dSYM/Contents/Resources/DWARF/Chromium Framework\n");
  const both = asBash(check);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.stdout, "reached\n");
});

test("publish-engine.sh stops when the release it uploaded to doesn't list the symbols archive and the UUID list", () => {
  const stubBin = join(work, "guard-bin");
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    join(stubBin, "gh"),
    `#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
[ "$1 $2 $3 $4" = "release view engine-cccccccccccc -R" ] || { echo "unexpected: gh $*" >&2; exit 2; }
[ -z "\${STUB_GH_FAIL:-}" ] || exit 1
printf '%s' "$STUB_LISTED"
`,
  );
  chmodSync(join(stubBin, "gh"), 0o755);
  const path = `${stubBin}:${process.env.PATH}`;
  const check = "require_release_symbols engine-cccccccccccc";
  const listing = (...names) => names.join("\n");
  const symbols = "ArdiaCore-cccccccccccc-symbols.tar.xz";
  const uuids = "ArdiaCore-cccccccccccc-uuids.txt";
  const engine = "ArdiaCore-cccccccccccc.tar.xz";

  const withoutBoth = asBash(check, { PATH: path, STUB_LISTED: listing(engine, `${engine}.sha256`) });
  assert.equal(withoutBoth.status, 1);
  assert.match(withoutBoth.stderr, /engine-cccccccccccc doesn't list ArdiaCore-cccccccccccc-symbols\.tar\.xz/);
  assert.equal(withoutBoth.stdout, "");

  const withoutUuids = asBash(check, { PATH: path, STUB_LISTED: listing(engine, symbols) });
  assert.equal(withoutUuids.status, 1);
  assert.match(withoutUuids.stderr, /engine-cccccccccccc doesn't list ArdiaCore-cccccccccccc-uuids\.txt/);

  const lookalike = asBash(check, { PATH: path, STUB_LISTED: listing(`${symbols}.part`, `x${uuids}`) });
  assert.equal(lookalike.status, 1, "only the exact asset names count");

  const unreadable = asBash(check, { PATH: path, STUB_LISTED: listing(symbols, uuids), STUB_GH_FAIL: "1" });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /couldn't list engine-cccccccccccc's assets/);

  const listed = asBash(check, { PATH: path, STUB_LISTED: listing(engine, symbols, uuids, "ArdiaCore-cccccccccccc-source.tar.xz") });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "reached\n");
});

test("publish-engine.sh checks both before it records the engine in prebuilt-engines.tsv", () => {
  const source = readFileSync(join(scripts, "publish-engine.sh"), "utf8");
  const pack = source.indexOf('pack-symbols.sh" "$work/Ardia.app/Contents/Frameworks/Chromium Framework.framework"');
  const before = source.indexOf('require_symbol_assets "$symbols_archive" "$uuids_file"');
  const upload = source.indexOf('run gh release upload "$tag" -R "$REPO" --clobber "${assets[@]}"');
  const after = source.indexOf('require_release_symbols "$tag"');
  const record = source.indexOf('printf \'%s\\n\' "$line" >>"$table"');
  assert.ok(pack > 0 && before > pack && upload > before, "the files are checked after packing and before the upload");
  assert.ok(after > upload && record > after, "the release's asset list is checked after the upload and before the table line");
});
