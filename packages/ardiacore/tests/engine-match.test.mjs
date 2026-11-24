import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = join(repoRoot, "packages/ardiacore/scripts");
const matchScript = join(scripts, "engine-match.sh");
const isMac = process.platform === "darwin";
const HEADER = "engine/ardiacore/src/ardia/core/public/api.h";

const scratch = () => fs.mkdtempSync(join(os.tmpdir(), "engine-match-"));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...process.env, ARDIACORE_ALLOW_PUBLIC_MISMATCH: "", ARDIACORE_ENGINE_MATCH: "", ...opts.env } });
const write = (root, rel, text, mode) => {
  fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
  fs.writeFileSync(join(root, rel), text, mode ? { mode } : undefined);
};
const git = (root, ...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const field = (line, name) => line.split(" ").find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1);

const FAKE_KEY = `#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
[ "$1" = --platform ] && shift 2
if [ "\${1:-}" = --paths ]; then echo engine; else git -C "$root" ls-tree -r "\${1:-HEAD}" engine | shasum -a 256 | cut -c1-64; fi
if [ -n "\${MOVE_HEAD_TO:-}" ] && [ ! -e "$root/moved-head" ]; then
  touch "$root/moved-head"
  git -C "$root" -c advice.detachedHead=false checkout -q --detach "$MOVE_HEAD_TO"
fi
`;

function checkout({ row = true, archive = false } = {}) {
  const root = scratch();
  for (const name of ["fetch-engine.sh", "engine-match.sh", "stage-framework.sh"]) {
    write(root, `packages/ardiacore/scripts/${name}`, fs.readFileSync(join(scripts, name), "utf8"), 0o755);
  }
  write(root, "scripts/lib/paths.sh", fs.readFileSync(join(repoRoot, "scripts/lib/paths.sh"), "utf8"));
  write(root, "engine/engine-key.sh", FAKE_KEY, 0o755);
  write(root, HEADER, "int api(void);\n");
  write(root, "engine/patch.txt", "one\n");
  write(root, "bin/curl", `#!/bin/bash\ncase "$*" in *file://*) exec /usr/bin/curl "$@" ;; esac\necho called >> "${root}/curl-calls"\nexit 22\n`, 0o755);
  fs.writeFileSync(join(root, ".gitignore"), "curl-calls\nmoved-head\nstage/\ncache/\n.DS_Store\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "engine one");
  const base = git(root, "rev-parse", "HEAD");
  const key = execFileSync(join(root, "engine/engine-key.sh"), ["--platform", "macos"], { encoding: "utf8" }).trim();
  const tag = `engine-${key.slice(0, 12)}`;
  const assets = scratch();
  let sha = "0".repeat(64);
  if (archive) {
    const pack = scratch();
    write(pack, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
    fs.mkdirSync(join(assets, tag));
    const file = join(assets, tag, `ArdiaCore-${key.slice(0, 12)}.tar.xz`);
    execFileSync("tar", ["-cJf", file, "-C", pack, "Chromium Framework.framework"]);
    sha = execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(" ")[0];
  }
  write(root, "packages/ardiacore/prebuilt-engines.tsv", row ? `${key}\t${tag}\t${sha}\n` : "# none\n");
  const store = join(root, "apps/browser/build-ardiacore/prebuilt", key.slice(0, 12));
  if (!archive) {
    write(store, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
    write(store, ".complete", "");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "published from here");
  const published = git(root, "rev-parse", "HEAD");
  git(root, "tag", tag, published);
  return { root, key, tag, base, published, store, assets, framework: join(store, "Chromium Framework.framework") };
}

const commitFile = (root, rel, text) => {
  write(root, rel, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `change ${rel}`);
};

const envFor = (root, extra = {}) => ({ PATH: `${join(root, "bin")}:${process.env.PATH}`, ARDIACORE_PREBUILT_REPO: "none/none", ARDIACORE_ENGINE_TAG_REMOTE: join(root, "no-remote"), ...extra });
const fetchEngine = (root, args = [], extra) => run(join(root, "packages/ardiacore/scripts/fetch-engine.sh"), args, { env: envFor(root, extra) });
const resolve = (root, line) => run(matchScript, ["resolve", root, line]);
const record = (store) => fs.readFileSync(join(store, "engine-match"), "utf8").trim();
const publicHashAt = (root, commit) => run(matchScript, ["public-hash", root, commit]).stdout.trim();

test("an exact engine is recorded with its key, release, the commit it was published from and its public headers' hash", () => {
  const { root, key, tag, base, published, store, framework } = checkout();
  const r = fetchEngine(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), framework);
  assert.notEqual(published, base, "the release tag sits on a later commit than the last engine change");
  assert.equal(record(store), `match=exact key=${key} version=${tag} source=${published} public_tree=${publicHashAt(root, base)}`);
  assert.match(field(record(store), "public_tree"), /^[0-9a-f]{64}$/);
});

test("the published source comes from the remote's tag only while downloading, and a miss is kept so a cached engine never asks again", () => {
  const { root, tag, published, store, assets } = checkout({ archive: true });
  const remote = join(scratch(), "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", root, remote]);
  git(root, "tag", "-d", tag);
  const download = { ARDIACORE_PREBUILT_ASSETS: `file://${assets}` };
  const first = fetchEngine(root, [], { ...download, ARDIACORE_ENGINE_TAG_REMOTE: remote });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(field(record(store), "source"), published);
  fs.rmSync(store, { recursive: true });
  assert.equal(fetchEngine(root, [], download).status, 0, "a remote that doesn't answer leaves the source empty");
  assert.equal(field(record(store), "source"), "");
  const hit = fetchEngine(root, [], { ARDIACORE_ENGINE_TAG_REMOTE: remote });
  assert.equal(hit.status, 0, hit.stderr);
  assert.equal(field(record(store), "source"), "", "a cached engine whose lookup missed doesn't ask the remote again");
  git(root, "tag", tag, published);
  assert.equal(fetchEngine(root).status, 0);
  assert.equal(field(record(store), "source"), published, "a tag fetched since is read locally");
});

test("a cached engine with no record never asks the remote for its source", () => {
  const { root, tag, store } = checkout();
  const remote = join(scratch(), "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", root, remote]);
  git(root, "tag", "-d", tag);
  assert.equal(fetchEngine(root, [], { ARDIACORE_ENGINE_TAG_REMOTE: remote }).status, 0);
  assert.equal(field(record(store), "source"), "");
});

test("the public headers hash the same from a commit and from disk, and move with content, mode and the files git shows", () => {
  const { root } = checkout();
  const atHead = publicHashAt(root, "HEAD");
  const onDisk = () => run(matchScript, ["public-hash", root]).stdout.trim();
  assert.equal(onDisk(), atHead);
  write(root, HEADER, "int api(int);\n");
  assert.notEqual(onDisk(), atHead);
  write(root, HEADER, "int api(void);\n");
  fs.chmodSync(join(root, HEADER), 0o755);
  assert.notEqual(onDisk(), atHead, "a mode change counts, as in the committed tree");
  fs.chmodSync(join(root, HEADER), 0o644);
  write(root, "engine/ardiacore/src/ardia/core/public/.DS_Store", "x");
  assert.equal(onDisk(), atHead, "an ignored file doesn't count");
  write(root, "engine/ardiacore/src/ardia/core/public/new.h", "int added(void);\n");
  assert.notEqual(onDisk(), atHead, "an untracked file git status shows counts");
  fs.rmSync(join(root, "engine/ardiacore/src/ardia/core/public/new.h"));
  fs.rmSync(join(root, HEADER));
  assert.notEqual(onDisk(), atHead, "a deleted tracked file counts");
});

test("a nearest engine is judged by the tree: unchanged public headers build, changed ones stop the build", () => {
  const { root, key, store } = checkout();
  commitFile(root, "engine/patch.txt", "two\n");
  assert.notEqual(fetchEngine(root).status, 0, "without --nearest an older engine is refused");
  assert.equal(fetchEngine(root, ["--nearest"]).status, 0);
  const same = resolve(root, record(store)).stdout.trim();
  assert.match(same, new RegExp(`^match=nearest key=${key} .* public=same$`));
  assert.equal(run(matchScript, ["check", same]).status, 0);
  commitFile(root, HEADER, "int api(int);\n");
  const warned = fetchEngine(root, ["--nearest"]);
  assert.match(warned.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH/);
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
});

test("a record written for an exact engine can't vouch for a later committed public header change", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  assert.match(record(store), /^match=exact /);
  commitFile(root, HEADER, "int api(int);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
  const stage = join(root, "packages/ardiacore/scripts/stage-framework.sh");
  const stopped = run(stage, [], { env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache") } });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /differs from that of/);
  assert.equal(fs.existsSync(join(root, "stage/Chromium Framework.framework")), false);
  const stale = run(stage, [], { env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache"), ARDIACORE_ENGINE_MATCH: `${record(store)} public=same` } });
  assert.equal(stale.status, 1, "a resolved line passed in is judged again");
});

test("an uncommitted public header edit makes an exact engine nearest and stops the build", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  write(root, HEADER, "int api(int);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
  const stopped = run(join(root, "packages/ardiacore/scripts/stage-framework.sh"), [], {
    env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache") },
  });
  assert.equal(stopped.status, 1);
  write(root, "engine/patch.txt", "dirty\n");
  write(root, HEADER, "int api(void);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=same$/, "other uncommitted engine edits keep it buildable but not exact");
});

test("in a build slot, a copy with no git, the stored match stands and the public headers are still compared", () => {
  const { root, store } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const slot = scratch();
  fs.cpSync(join(root, "engine"), join(slot, "engine"), { recursive: true });
  assert.match(resolve(slot, record(store)).stdout.trim(), /^match=exact .* public=same$/);
  write(slot, HEADER, "int api(int);\n");
  const changed = resolve(slot, record(store)).stdout.trim();
  assert.match(changed, /^match=nearest .* public=changed$/);
  assert.equal(run(matchScript, ["check", changed]).status, 1);
});

test("--describe prints the record without downloading, and --offline never reaches the network", () => {
  const { root, key, store } = checkout();
  fs.rmSync(store, { recursive: true });
  const r = fetchEngine(root, ["--describe"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), new RegExp(`^match=exact key=${key} `));
  assert.equal(fs.existsSync(store), false);
  const missing = checkout({ row: false });
  const offline = fetchEngine(missing.root, ["--describe", "--offline"]);
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(offline.stdout.trim(), `match=unknown key=${missing.key} version= source= public_tree=${publicHashAt(missing.root, missing.base)}`);
  assert.equal(fs.existsSync(join(missing.root, "curl-calls")), false);
  assert.notEqual(fetchEngine(root, ["--offline"]).status, 0);
});

const cachedEngine = (root, key) => {
  const cache = scratch();
  const dir = join(cache, "engines", key.slice(0, 12));
  write(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(dir, ".complete", "");
  const engine = () => run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], { env: envFor(root, { AC_APP_CACHE: cache }) });
  engine.dir = dir;
  return { dir, engine, line: () => fs.readFileSync(join(dir, "engine-match"), "utf8").trim() };
};

test("a cached engine with no record keeps its hit offline as unknown, and its committed headers are still checked", () => {
  const { root, key, base } = checkout({ row: false });
  const { dir, engine, line } = cachedEngine(root, key);
  const r = engine();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(dir, "Chromium Framework.framework"));
  assert.equal(line(), `match=unknown key=${key} version= source= public_tree=${publicHashAt(root, base)}`);
  assert.equal(fs.existsSync(join(root, "curl-calls")), false);
  const clean = resolve(root, line()).stdout.trim();
  assert.match(clean, /^match=unknown .* public=same$/);
  assert.equal(run(matchScript, ["check", clean]).status, 0);
});

test("a cached engine with no record and an uncommitted public header edit recovers the committed headers and refuses the build", () => {
  const { root, key, base } = checkout({ row: false });
  write(root, HEADER, "int api(int);\n");
  const { engine, line } = cachedEngine(root, key);
  assert.equal(engine().status, 0);
  assert.equal(field(line(), "public_tree"), publicHashAt(root, base));
  const judged = resolve(root, line()).stdout.trim();
  assert.match(judged, /^match=unknown .* public=changed$/);
  const stopped = run(matchScript, ["check", judged]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /differs from that of engine /);
});

test("an engine whose headers nothing records fails closed unless overridden", () => {
  const unrecorded = "match=unknown key=k version= source= public_tree= public=unknown";
  const stopped = run(matchScript, ["check", unrecorded]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /nothing records/);
  assert.equal(run(matchScript, ["check", unrecorded], { env: { ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } }).status, 0);
  assert.equal(resolve(scratch(), "match=unknown key=k").stdout.trim(), unrecorded);
  assert.equal(run(matchScript, ["check", "match=exact key=k public=unknown"]).status, 1);
});

test("a cached engine whose row is in the local table gets its full record offline", () => {
  const { root, key, published } = checkout();
  const cache = scratch();
  const dir = join(cache, "engines", key.slice(0, 12));
  write(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(dir, ".complete", "");
  write(dir, "engine-match", `match=exact key=${key} version=engine-x source=old public=same\n`);
  const r = run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], { env: envFor(root, { AC_APP_CACHE: cache }) });
  assert.equal(r.status, 0, r.stderr);
  const line = fs.readFileSync(join(dir, "engine-match"), "utf8").trim();
  assert.match(line, new RegExp(`^match=exact key=${key} .*source=${published} public_tree=[0-9a-f]{64}$`));
});

test("check passes exact, local, unknown and unchanged nearest engines and stops a changed one unless overridden", () => {
  for (const line of ["match=exact key=k public=same", "match=local", "", "match=nearest key=k public=same", "match=unknown key=k public=same"]) {
    assert.equal(run(matchScript, ["check", line]).status, 0, line);
  }
  const changed = "match=nearest key=k version=engine-abc source=0123456789abcdef public=changed";
  const stopped = run(matchScript, ["check", changed]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /public differs from that of engine-abc's engine \(published from 0123456789\)/);
  assert.match(stopped.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH=1/);
  const allowed = run(matchScript, ["check", changed], { env: { ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stderr, /warning/);
  assert.equal(run(matchScript, ["check", "match=nearest key=k"]).status, 1, "an unresolved nearest line is treated as changed");
  assert.equal(run(matchScript, ["check", "match=close"]).status, 1);
});

test("get reads one field and calls a line without a match local", () => {
  assert.equal(run(matchScript, ["get", "public", "match=nearest public=changed"]).stdout.trim(), "changed");
  assert.equal(run(matchScript, ["get", "match", ""]).stdout.trim(), "local");
  assert.equal(run(matchScript, ["get", "source", "match=local"]).stdout.trim(), "");
  assert.equal(resolve(scratch(), "match=local").stdout.trim(), "match=local");
});

test("stage-framework records the resolved line beside the staged framework", { skip: !isMac }, () => {
  const { root, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const stageDir = join(root, "stage");
  const stage = join(root, "packages/ardiacore/scripts/stage-framework.sh");
  write(stageDir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(stageDir, ".stamp", run(stage, ["--key", framework]).stdout);
  const env = { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: stageDir, ARDIACORE_STAGE_CACHE: join(root, "cache") };
  const ok = run(stage, [], { env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(join(stageDir, "engine-match"), "utf8"), /^match=exact .* public=same$/m);
  commitFile(root, HEADER, "int api(int);\n");
  const allowed = run(stage, [], { env: { ...env, ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(fs.readFileSync(join(stageDir, "engine-match"), "utf8"), /^match=nearest .* public=changed$/m);
  const local = run(stage, [], { env: { ...env, ARDIACORE_ENGINE_MATCH: "match=local" } });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(fs.readFileSync(join(stageDir, "engine-match"), "utf8").trim(), "match=local");
});

test("plist writes the engine keys into the app's Info.plist, and a local build keeps only its match", { skip: !isMac }, () => {
  const plist = join(scratch(), "Info.plist");
  write(dirname(plist), "Info.plist", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Ardia</string></dict></plist>\n');
  const read = () => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }));
  const r = run(matchScript, ["plist", "match=nearest key=abc version=engine-abc source=0123 public_tree=ff public=same", plist]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "nearest", ArdiaEngineKey: "abc", ArdiaEngineVersion: "engine-abc", ArdiaEngineSource: "0123" });
  assert.equal(run(matchScript, ["plist", "match=unknown key=abc version= source= public_tree=ff public=same", plist]).status, 0);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "unknown", ArdiaEngineKey: "abc" });
  assert.equal(run(matchScript, ["plist", "match=local", plist]).status, 0);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
  const stopped = run(matchScript, ["plist", "match=nearest key=abc public=changed", plist]);
  assert.equal(stopped.status, 1);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
});

test("build-app judges the engine again after taking its lock, right before it stamps the app cache", () => {
  const text = fs.readFileSync(join(repoRoot, "scripts/agent/build-app"), "utf8");
  const lock = text.indexOf('exec lockf -k -t "$wait" "$dd/.build-app.lock"');
  const again = text.indexOf("judge_engine || exit 1", lock);
  const stamp = text.indexOf("stamp=$(stamp_now)");
  assert.ok(lock > 0 && again > lock && again < stamp, "the judgement after the lock comes before the stamp");
  assert.ok(text.lastIndexOf("judge_engine || exit 1", lock) > 0, "and once before staging, to fail fast");
});

test("an engine input changed after the first judgement changes the judged line, so the cache stamp can't reuse the old app", async () => {
  const lib = await import(join(repoRoot, "scripts/lib/build-cache.mjs"));
  const { root, store } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const before = resolve(root, record(store)).stdout.trim();
  assert.match(before, /^match=exact /);
  write(root, "engine/patch.txt", "edited while staging\n");
  const uncommitted = resolve(root, record(store)).stdout.trim();
  assert.match(uncommitted, /^match=nearest .* public=same$/);
  commitFile(root, "engine/patch.txt", "committed while staging\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=same$/);
  const lines = (match) => lib.envFingerprint({ ARDIACORE_ENGINE_MATCH: match }).lines;
  assert.deepEqual(lines(before), [`env ARDIACORE_ENGINE_MATCH=${before}`]);
  assert.notDeepEqual(lines(before), lines(uncommitted));
});

test("a cached record from before the header hash covered modes is rewritten offline, so a clean tree still builds", () => {
  const { root, key, published } = checkout();
  const { dir, engine, line } = cachedEngine(root, key);
  write(dir, "engine-match", `match=exact key=${key} version=engine-x source=${published} public_hash=${"0".repeat(64)}\n`);
  assert.equal(engine().status, 0);
  assert.match(line(), /public_tree=[0-9a-f]{64}$/);
  const judged = resolve(root, line()).stdout.trim();
  assert.match(judged, /^match=exact .* public=same$/);
  assert.equal(run(matchScript, ["check", judged]).status, 0);
});

const withHeadMovingTo = (root) => {
  const start = git(root, "rev-parse", "HEAD");
  commitFile(root, HEADER, "int api(long);\n");
  const moved = git(root, "rev-parse", "HEAD");
  git(root, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", start);
  return moved;
};

test("fetch-engine.sh reads one commit for the key, the row and the header hash even when HEAD moves mid-run", () => {
  const { root, key, base, store } = checkout();
  const moved = withHeadMovingTo(root);
  const r = fetchEngine(root, [], { MOVE_HEAD_TO: moved });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(join(root, "moved-head")), "HEAD did move during the run");
  assert.equal(field(record(store), "key"), key);
  assert.equal(field(record(store), "public_tree"), publicHashAt(root, base));
});

test("build-cache records the engine of the commit it chose its cache entry by, even when HEAD moves mid-run", () => {
  const { root, key, base } = checkout();
  const moved = withHeadMovingTo(root);
  const { engine, line } = cachedEngine(root, key);
  const r = run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], { env: envFor(root, { AC_APP_CACHE: dirname(dirname(engine.dir)), MOVE_HEAD_TO: moved }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(join(root, "moved-head")), "HEAD did move during the run");
  assert.equal(field(line(), "key"), key);
  assert.equal(field(line(), "public_tree"), publicHashAt(root, base));
});

test("a cached record for another engine key is replaced, never trusted", async () => {
  const lib = await import(join(repoRoot, "scripts/lib/build-cache.mjs"));
  const { root, key, base } = checkout();
  const { dir, engine, line } = cachedEngine(root, key);
  write(dir, "engine-match", `match=exact key=${"b".repeat(64)} version=engine-bbbbbbbbbbbb source= public_tree=${"0".repeat(64)}\n`);
  assert.equal(lib.engineRecordComplete(join(dir, "engine-match"), key), false);
  assert.equal(engine().status, 0);
  assert.equal(field(line(), "key"), key);
  assert.equal(field(line(), "public_tree"), publicHashAt(root, base));
  assert.equal(lib.engineRecordComplete(join(dir, "engine-match"), key), true);
});

test("a clean header with a non-ASCII name hashes the same from its commit and from disk", () => {
  const { root } = checkout();
  commitFile(root, "engine/ardiacore/src/ardia/core/public/café.h", "int cafe(void);\n");
  assert.equal(run(matchScript, ["public-hash", root]).stdout.trim(), publicHashAt(root, "HEAD"));
  assert.match(resolve(root, `match=exact key=k public_tree=${publicHashAt(root, "HEAD")}`).stdout.trim(), /public=same$/);
});

test("a tag lookup that never answers ends at its deadline and leaves no helper behind", async () => {
  const net = await import("node:net");
  const held = [];
  const server = net.createServer((socket) => held.push(socket));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const remote = `http://127.0.0.1:${server.address().port}/silent.git`;
  try {
    const { root, tag, store, assets } = checkout({ archive: true });
    git(root, "tag", "-d", tag);
    const started = Date.now();
    const r = fetchEngine(root, [], { ARDIACORE_PREBUILT_ASSETS: `file://${assets}`, ARDIACORE_ENGINE_TAG_REMOTE: remote, ARDIACORE_ENGINE_TAG_DEADLINE: "2" });
    const took = Date.now() - started;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(took < 15_000, `took ${took} ms`);
    assert.equal(field(record(store), "source"), "");
    const left = spawnSync("pgrep", ["-f", remote], { encoding: "utf8" });
    assert.equal(left.stdout.trim(), "", `still running: ${left.stdout}`);
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
  }
});

test("resolve takes the key, the dirty check and the headers from one commit, and refuses when HEAD moves meanwhile", () => {
  const { root, store } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const line = record(store);
  const start = git(root, "rev-parse", "HEAD");
  const moved = withHeadMovingTo(root);
  const r = run(matchScript, ["resolve", root, line], { env: { MOVE_HEAD_TO: moved } });
  assert.ok(fs.existsSync(join(root, "moved-head")), "HEAD did move during the judgement");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /moved off .* while its engine was judged/);
  git(root, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", start);
  assert.match(resolve(root, line).stdout.trim(), /^match=exact /);
  write(root, "engine/patch.txt", "staged\n");
  git(root, "add", "engine/patch.txt");
  assert.match(resolve(root, line).stdout.trim(), /^match=nearest /, "a staged engine change is judged against the pinned commit");
});

test("a build slot stamps the engine judged after syncing, and refuses a tree that changed while it was judged", async () => {
  const lib = await import(join(repoRoot, "scripts/lib/build-cache.mjs"));
  const { root, store } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const beforeSync = resolve(root, record(store)).stdout.trim();
  assert.match(beforeSync, /^match=exact /);
  commitFile(root, "engine/patch.txt", "changed after build-app judged\n");
  const synced = lib.manifestOf(root, lib.listFiles(root));
  const judged = lib.judgeSyncedEngine(root, record(store), synced);
  assert.match(judged, /^match=nearest .* public=same$/, "the synced files' engine, not the earlier exact");
  assert.notDeepEqual(lib.envFingerprint({ ARDIACORE_ENGINE_MATCH: judged }).lines, lib.envFingerprint({ ARDIACORE_ENGINE_MATCH: beforeSync }).lines);
  write(root, "engine/patch.txt", "changed after the sync\n");
  assert.throws(() => lib.judgeSyncedEngine(root, record(store), synced), /tree changed while its engine was judged/);
});

test("stage-framework refuses when the engine it judges differs from the one build-app judged for this build", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const judged = resolve(root, record(store)).stdout.trim();
  commitFile(root, "engine/patch.txt", "changed while building\n");
  const stopped = run(join(root, "packages/ardiacore/scripts/stage-framework.sh"), [], {
    env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache"), ARDIACORE_ENGINE_MATCH: judged },
  });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /the tree changed meanwhile/);
});

test("a cached engine recorded for another key is discarded and fetched again, never re-recorded", () => {
  const { root, key, assets } = checkout({ archive: true });
  const cache = scratch();
  const dir = join(cache, "engines", key.slice(0, 12));
  write(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "another engine's bytes");
  write(dir, ".complete", "");
  write(dir, "engine-match", `match=exact key=${"b".repeat(64)} version=engine-bbbbbbbbbbbb source= public_tree=${"0".repeat(64)}\n`);
  const r = run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], {
    env: envFor(root, { AC_APP_CACHE: cache, ARDIACORE_PREBUILT_ASSETS: `file://${assets}` }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /recorded for another key/);
  assert.equal(fs.readFileSync(join(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework"), "utf8"), "binary");
  assert.equal(field(fs.readFileSync(join(dir, "engine-match"), "utf8").trim(), "key"), key);
});

test("fetch-engine.sh refetches a cached engine recorded for another key instead of re-recording it", () => {
  const { root, key, store, assets, framework } = checkout({ archive: true });
  write(store, "Chromium Framework.framework/Versions/Current/Chromium Framework", "another engine's bytes");
  write(store, ".complete", "");
  write(store, "engine-match", `match=exact key=${"b".repeat(64)} version=engine-bbbbbbbbbbbb source= public_tree=${"0".repeat(64)}\n`);
  const r = fetchEngine(root, [], { ARDIACORE_PREBUILT_ASSETS: `file://${assets}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), framework);
  assert.match(r.stderr, /recorded for bbbbbbbbbbbb, not /);
  assert.equal(fs.readFileSync(join(framework, "Versions/Current/Chromium Framework"), "utf8"), "binary");
  assert.equal(field(record(store), "key"), key);
});

test("a framework reached through a symlink is judged by the record at its real path", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const link = join(scratch(), "Chromium Framework.framework");
  fs.symlinkSync(framework, link);
  assert.equal(run(matchScript, ["record-of", link]).stdout.trim(), record(store));
  commitFile(root, HEADER, "int api(int);\n");
  const stopped = run(join(root, "packages/ardiacore/scripts/stage-framework.sh"), [], {
    env: { ARDIACORE_FRAMEWORK: link, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache") },
  });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /differs from that of/);
});

test("a framework in a prebuilt store with no record is unknown, never local; one elsewhere is local", () => {
  const { root, store, framework } = checkout();
  assert.equal(run(matchScript, ["record-of", framework]).stdout.trim(), "match=unknown key=");
  const cache = scratch();
  write(cache, "engines/abc/Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  assert.equal(run(matchScript, ["record-of", join(cache, "engines/abc/Chromium Framework.framework")], { env: { AC_APP_CACHE: cache } }).stdout.trim(), "match=unknown key=");
  const elsewhere = scratch();
  write(elsewhere, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  assert.equal(run(matchScript, ["record-of", join(elsewhere, "Chromium Framework.framework")]).stdout.trim(), "match=local");
  assert.equal(run(matchScript, ["check", resolve(root, "match=unknown key=").stdout.trim()]).status, 1);
  assert.ok(store);
});
