import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lib from "./build-cache.mjs";

const scratch = () => fs.mkdtempSync(join(tmpdir(), "build-cache-test-"));
const write = (root, rel, text, mode) => {
  const path = join(root, rel);
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, text);
  if (mode) fs.chmodSync(path, mode);
  return path;
};

const POD_SOURCE = "packages/base/ios/Base.swift";
const PROJECT = "apps/browser/macos/Fake.xcodeproj/project.pbxproj";

function repo() {
  const dir = scratch();
  execFileSync("git", ["init", "-q", dir]);
  write(dir, "apps/browser/macos/FakeApp/Delegate.swift", "class Delegate {}\n");
  write(dir, PROJECT, "buildPhases = (\nStage,\nSources,\n);\n");
  write(dir, "apps/browser/macos/Fake.lock", "PODS: []\n");
  write(dir, POD_SOURCE, "struct Base {}\n");
  write(dir, "packages/base/package.json", '{"name":"base"}\n');
  write(dir, "packages/base/src/index.ts", "export const base = 1;\n");
  write(dir, "apps/browser/src/FakeScreen.tsx", "export default 1;\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(dir, ".gitignore", "node_modules\n/apps/browser/build-*/\n");
  write(dir, "apps/browser/build-x/ignored.o", "x");
  return dir;
}

const framework = () => {
  const dir = join(scratch(), "Chromium Framework.framework");
  write(dir, "Versions/A/Chromium Framework", "engine");
  write(dir, "Versions/A/Helpers/helper", "helper", 0o755);
  fs.symlinkSync("A", join(dir, "Versions/Current"));
  return dir;
};

const inputs = (extra = {}) => ({
  framework: "framework f1",
  toolchain: "toolchain Xcode 27.2 | 27B52",
  env: lib.envFingerprint({ PATH: "/bin" }),
  ...extra,
});

const stampOf = (dir, extra = {}) =>
  lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Debug", signing: "default", ...inputs(extra) });

test("the native rules take sources, Pods inputs, patches, the lockfile and the Rust core, and leave JS out", () => {
  for (const rel of [POD_SOURCE, PROJECT, "apps/browser/macos/Fake.lock", "patches/x.patch", "pnpm-lock.yaml", "packages/base/package.json", "packages/core-rs/fake.toml", "engine/ardiacore/src/ardia/core/public/Fake.h"]) {
    assert.ok(lib.isNative(rel), rel);
  }
  for (const rel of ["apps/browser/src/FakeScreen.tsx", "packages/base/src/index.ts", "docs/fake.md"]) assert.ok(!lib.isNative(rel), rel);
});

test("the stamp ignores JS and ignored files", () => {
  const dir = repo();
  const before = stampOf(dir);
  write(dir, "apps/browser/src/FakeScreen.tsx", "export default 2;\n");
  write(dir, "packages/base/src/index.ts", "export const base = 2;\n");
  write(dir, "apps/browser/build-x/ignored.o", "y");
  assert.equal(stampOf(dir), before);
});

test("the stamp changes with every native input, a .pbxproj reorder included", () => {
  const dir = repo();
  const seen = new Set([stampOf(dir)]);
  const expectNew = (label, value) => {
    assert.ok(!seen.has(value), label);
    seen.add(value);
  };
  write(dir, POD_SOURCE, "struct Base { let a = 1 }\n");
  expectNew("pod source", stampOf(dir));
  write(dir, PROJECT, "buildPhases = (\nSources,\nStage,\n);\n");
  expectNew("pbxproj phase order", stampOf(dir));
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9.1\n");
  expectNew("lockfile", stampOf(dir));
  write(dir, "patches/fake@1.0.0.patch", "diff\n");
  expectNew("new patch", stampOf(dir));
  write(dir, "packages/core-rs/fake.toml", "version = 4\n");
  expectNew("rust core", stampOf(dir));
  fs.chmodSync(join(dir, POD_SOURCE), 0o755);
  expectNew("exec bit", stampOf(dir));
  expectNew("config", lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Release", ...inputs() }));
  expectNew("signing", lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Debug", signing: "adhoc", ...inputs() }));
  expectNew("framework", stampOf(dir, { framework: "framework f2" }));
  expectNew("toolchain", stampOf(dir, { toolchain: "toolchain Xcode 27.3 | 27C1" }));
  expectNew("new arch", stampOf(dir, { env: lib.envFingerprint({ RCT_NEW_ARCH_ENABLED: "1" }) }));
  expectNew("toolchains", stampOf(dir, { env: lib.envFingerprint({ TOOLCHAINS: "swift" }) }));
});

test("the environment fingerprint keeps build variables, drops the rest, and blocks an xcconfig override", () => {
  const fp = lib.envFingerprint({ RCT_NEW_ARCH_ENABLED: "0", TOOLCHAINS: "x", CC: "clang", HOME: "/h", PATH: "/bin", AC_LOCKED_AS: "me" });
  assert.deepEqual(fp.lines, ["env CC=clang", "env RCT_NEW_ARCH_ENABLED=0", "env TOOLCHAINS=x"]);
  assert.deepEqual(fp.blocked, []);
  assert.deepEqual(lib.envFingerprint({ XCODE_XCCONFIG_FILE: "/x.xcconfig" }).blocked, ["XCODE_XCCONFIG_FILE"]);
  assert.deepEqual(lib.envFingerprint({ SKIP_BUNDLING: "1", BUNDLE_NAME: "x", FORCE_BUNDLING: "1" }).blocked, ["BUNDLE_NAME", "FORCE_BUNDLING", "SKIP_BUNDLING"]);
  assert.deepEqual(lib.envFingerprint({ NODE_ARGS: "--max-old-space-size=8192", CLI_PATH: "/x/cli.js" }).blocked, ["CLI_PATH", "NODE_ARGS"]);
  const withLocalEnv = scratch();
  write(withLocalEnv, "apps/browser/fake-macos/.xcode.env.local", "export NODE_BINARY=/opt/node/bin/node\n");
  const files = ["apps/browser/fake-macos/.xcode.env.local"];
  const generated = lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", repo: withLocalEnv, localEnvFiles: files });
  assert.equal(generated.blocked, undefined);
  assert.equal(generated.env.lines.length, 1);
  assert.match(generated.env.lines[0], /^xcode-env apps\/browser\/fake-macos\/\.xcode\.env\.local [0-9a-f]{64}$/);
  for (const bad of ["export NODE_BINARY=/opt/node/bin/node\nexport EXTRA=1\n", "export NODE_BINARY=/opt/node/bin/node\r\n", "export NODE_BINARY=node\n", "export NODE_BINARY=/opt/node/bin/node"]) {
    write(withLocalEnv, "apps/browser/fake-macos/.xcode.env.local", bad);
    assert.match(lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", repo: withLocalEnv, localEnvFiles: files }).blocked ?? "", /\.xcode\.env\.local/, JSON.stringify(bad));
  }
  write(withLocalEnv, "apps/browser/fake-macos/.xcode.env.local", "export NODE_BINARY=/opt/other/bin/node\n");
  const other = lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", repo: withLocalEnv, localEnvFiles: files });
  assert.notDeepEqual(other.env.lines, generated.env.lines);
  assert.equal(lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", repo: scratch() }).blocked, undefined);
  assert.match(lib.stampInputs({ framework: framework(), env: { XCODE_XCCONFIG_FILE: "/x" }, toolchain: "t" }).blocked, /XCODE_XCCONFIG_FILE/);
  assert.match(lib.stampInputs({ framework: "/nowhere", env: {}, toolchain: "t" }).blocked, /no engine framework/);
  assert.match(lib.stampInputs({ framework: framework(), env: {}, toolchain: null }).blocked, /toolchain/);
});

test("the framework is identified by the content of every file, wherever it sits", () => {
  const a = framework();
  const b = framework();
  const cache = new lib.HashCache(join(scratch(), "hashes.json"));
  assert.equal(lib.frameworkIdentity(a, cache), lib.frameworkIdentity(b, cache));
  const before = lib.frameworkIdentity(a, cache);
  const helper = join(a, "Versions/A/Helpers/helper");
  const st = fs.statSync(helper);
  fs.writeFileSync(helper, "HELPER");
  fs.utimesSync(helper, st.atime, st.mtime);
  assert.notEqual(lib.frameworkIdentity(a, cache), before);
  assert.equal(lib.frameworkIdentity(join(scratch(), "none.framework"), cache), null);
  cache.save();
  assert.ok(fs.existsSync(cache.path));
});

test("deps and Pods inputs: a new pod source file or a new-arch flag means a fresh pod install", () => {
  const dir = repo();
  const manifest = () => lib.manifestOf(dir, lib.listFiles(dir));
  const pods = lib.podsHash(manifest(), {});
  const deps = lib.depsHash(manifest(), {});
  write(dir, POD_SOURCE, "struct Base { let changed = 1 }\n");
  assert.equal(lib.podsHash(manifest(), {}), pods);
  write(dir, "packages/base/ios/Added.mm", "int added;\n");
  assert.notEqual(lib.podsHash(manifest(), {}), pods);
  assert.notEqual(lib.podsHash(manifest(), { RCT_NEW_ARCH_ENABLED: "1" }), lib.podsHash(manifest(), {}));
  assert.equal(lib.depsHash(manifest(), {}), deps);
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 10\n");
  assert.notEqual(lib.depsHash(manifest(), {}), deps);
});

function fakeApp(root, marker = "app") {
  const app = join(root, "Ardia.app");
  write(app, "Contents/MacOS/Ardia", marker);
  return app;
}
const one = () => 1;
const S1 = "1".repeat(32);
const S2 = "2".repeat(32);
const appText = (entry) => fs.readFileSync(join(entry.app, "Contents/MacOS/Ardia"), "utf8");

test("the cache is keyed by stamp: a miss, a store, then a hit", () => {
  const cache = scratch();
  assert.equal(lib.lookup(cache, S1), null);
  const stored = lib.store(cache, S1, fakeApp(scratch(), "built"), { config: "Debug", head: "abc" }, { measure: () => 10 });
  assert.equal(stored.meta.stamp, S1);
  assert.match(stored.meta.digest, /^[0-9a-f]{64}$/);
  assert.equal(appText(lib.lookup(cache, S1)), "built");
  assert.equal(lib.lookup(cache, S2), null);
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

test("an entry is never replaced: a second publish of a stamp keeps the first and leaves no temp folder", () => {
  const cache = scratch();
  lib.store(cache, S1, fakeApp(scratch(), "first"), {}, { measure: one });
  const second = lib.store(cache, S1, fakeApp(scratch(), "second"), {}, { measure: one });
  assert.equal(second.existed, true);
  assert.equal(appText(lib.lookup(cache, S1)), "first");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

test("an entry without its app or digest, or with another stamp, is a miss", () => {
  const cache = scratch();
  write(cache, `${S1}/meta.json`, JSON.stringify({ stamp: S1, digest: "d" }));
  assert.equal(lib.lookup(cache, S1), null);
  write(cache, `${S2}/meta.json`, JSON.stringify({ stamp: "other", digest: "d" }));
  write(cache, `${S2}/Ardia.app/Contents/MacOS/Ardia`, "x");
  assert.equal(lib.lookup(cache, S2), null);
  write(cache, `${S2}/meta.json`, JSON.stringify({ stamp: S2 }));
  assert.equal(lib.lookup(cache, S2), null);
});

test("a restore snapshot must match the content digest recorded at publish, hermesc included", () => {
  const cache = scratch();
  const hermesc = write(scratch(), "hermesc", "hermesc v1", 0o755);
  const entry = lib.store(cache, S1, fakeApp(scratch(), "abc"), {}, { measure: one, hermesc });
  const snap = lib.snapshotEntry(entry, join(scratch(), "snap"));
  assert.equal(fs.readFileSync(join(snap.app, "Contents/MacOS/Ardia"), "utf8"), "abc");
  assert.equal(fs.readFileSync(snap.hermesc, "utf8"), "hermesc v1");
  fs.writeFileSync(join(entry.app, "Contents/MacOS/Ardia"), "xyz");
  assert.equal(lib.snapshotEntry(entry, join(scratch(), "same-size-edit")), null);
  fs.writeFileSync(join(entry.app, "Contents/MacOS/Ardia"), "abc");
  assert.ok(lib.snapshotEntry(entry, join(scratch(), "restored")));
  fs.rmSync(join(entry.dir, "hermesc"));
  assert.equal(lib.snapshotEntry(entry, join(scratch(), "no-hermesc")), null);
  fs.rmSync(entry.dir, { recursive: true });
  assert.equal(lib.snapshotEntry(entry, join(scratch(), "evicted")), null);
});

test("touching an entry that eviction removed reports it instead of throwing", () => {
  const cache = scratch();
  const entry = lib.store(cache, S1, fakeApp(scratch()), {}, { measure: one });
  fs.rmSync(entry.dir, { recursive: true });
  assert.equal(lib.touch(entry.dir), false);
  assert.equal(lib.lookup(cache, S1), null);
});

test("eviction keeps the most recently used within both caps, the protected entry and anything used in the grace period", () => {
  const list = [
    { stamp: "a", bytes: 4, usedAt: 1 },
    { stamp: "b", bytes: 4, usedAt: 4 },
    { stamp: "c", bytes: 4, usedAt: 3 },
    { stamp: "d", bytes: 4, usedAt: 2 },
  ];
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 100, maxEntries: 2, now: 1000 }).evict.map((e) => e.stamp), ["d", "a"]);
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 9, maxEntries: 10, now: 1000 }).keep.map((e) => e.stamp), ["b", "c"]);
  assert.ok(lib.evictionPlan(list, { maxBytes: 9, maxEntries: 2, protect: ["a"], now: 1000 }).keep.some((e) => e.stamp === "a"));
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 0, maxEntries: 0, graceMs: 2.5, now: 4 }).keep.map((e) => e.stamp), ["b", "c", "d"]);
});

test("evict removes the least recently used apps and engines on disk", () => {
  const cache = scratch();
  const stamps = ["a", "b", "c"].map((c) => c.repeat(32));
  for (const [i, s] of stamps.entries()) {
    const e = lib.store(cache, s, fakeApp(scratch()), {}, { measure: () => 5 });
    lib.touch(e.dir, new Date(1e12 + i * 1000));
  }
  for (const [i, key] of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].entries()) {
    write(cache, `engines/${key}/.complete`, "");
    lib.touch(join(cache, "engines", key), new Date(1e12 + i * 1000));
  }
  const plan = lib.evict(cache, { maxBytes: 100, maxEntries: 2, keepEngines: 1 });
  assert.deepEqual(plan.evict.map((e) => e.stamp), [stamps[0]]);
  assert.deepEqual(fs.readdirSync(cache).filter((n) => !n.startsWith(".")).sort(), [stamps[1], stamps[2], "engines"]);
  assert.deepEqual(fs.readdirSync(join(cache, "engines")), ["bbbbbbbbbbbb"]);
});

test("the lock holder path matches scripts/agent/locked's naming", () => {
  const dd = "/x/build-slots/2/ardia/apps/web/build-slot";
  const digest = execFileSync("sh", ["-c", `printf %s "${dd}" | shasum | cut -c1-8`], { encoding: "utf8" }).trim();
  assert.equal(lib.lockHolderPath(dd, "/tmp"), `/tmp/ac-xcodebuild-build-slot-${digest}.holder`);
});

test("slot selection: free slots only, nearest tree first", () => {
  const root = scratch();
  for (const n of ["1", "2", "3", "5"]) fs.mkdirSync(join(root, n));
  const manifest = { a: "1", b: "2", c: "3" };
  const states = {
    1: { manifest: { a: "1", b: "x", c: "y" }, syncedAt: 10 },
    2: { manifest: { a: "1", b: "2", c: "3" }, syncedAt: 5 },
    3: { manifest: { a: "1", b: "2", c: "3" }, syncedAt: 20 },
    5: { manifest: {}, syncedAt: 30 },
  };
  const readState = (slot) => states[slot.split("/").pop()];
  const busy = (slot) => slot.endsWith("/3");
  assert.deepEqual(lib.freeSlots(root, manifest, { busy, readState }), [join(root, "2"), join(root, "1"), join(root, "5")]);
  assert.deepEqual(lib.freeSlots(root, manifest, { busy: () => true, readState }), []);
});

test("a new slot is reserved atomically and stays busy while its owner lives", () => {
  const root = scratch();
  const a = lib.reserveSlot(root, process.pid);
  const b = lib.reserveSlot(root, process.pid);
  assert.notEqual(a, b);
  assert.ok(lib.slotBusy(a, { root: scratch() }));
  const dead = lib.reserveSlot(root, 999999);
  assert.ok(!lib.slotBusy(dead, { root: scratch() }));
  lib.releaseReservation(a);
  assert.ok(!lib.slotBusy(a, { root: scratch() }));
});

test("slot eviction drops the least recently used idle slots beyond the keep count", () => {
  const root = scratch();
  for (const n of ["1", "2", "3", "4"]) fs.mkdirSync(join(root, n));
  const used = { 1: 40, 2: 10, 3: 30, 4: 20 };
  const readState = (slot) => ({ syncedAt: used[slot.split("/").pop()] });
  const busy = (slot) => slot.endsWith("/2");
  assert.deepEqual(lib.slotsToEvict(root, { keep: 2, busy, readState, protect: [join(root, "4")] }), [join(root, "3")]);
  assert.deepEqual(lib.slotsToEvict(root, { keep: 3, busy, readState }), []);
});

test("syncing writes only changed files, with a fresh mtime, and removes deleted ones", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  const first = lib.manifestOf(src, lib.listFiles(src));
  assert.equal(lib.syncTree(src, slot, first).changed.length, Object.keys(first).length);
  const tree = lib.slotTree(slot);
  assert.equal(fs.existsSync(join(tree, "apps/browser/build-x/ignored.o")), false);
  const old = new Date(1e12);
  for (const rel of Object.keys(first)) fs.utimesSync(join(tree, rel), old, old);
  const keptInode = fs.statSync(join(tree, POD_SOURCE)).ino;
  lib.writeSlotState(slot, { ...lib.readSlotState(slot), syncedAt: Date.now() + 1 });

  const other = scratch();
  execFileSync("cp", ["-R", `${src}/.`, other]);
  write(other, "apps/browser/macos/FakeApp/Delegate.swift", "class Delegate { }\n");
  write(other, "packages/base/ios/run.sh", "#!/bin/sh\n", 0o755);
  fs.rmSync(join(other, "packages/base/src/index.ts"));
  const before = Date.now();
  const r = lib.syncTree(other, slot, lib.manifestOf(other, lib.listFiles(other)));
  assert.deepEqual(r.changed, ["apps/browser/macos/FakeApp/Delegate.swift", "packages/base/ios/run.sh"]);
  assert.deepEqual(r.removed, ["packages/base/src/index.ts"]);
  assert.deepEqual(r.mismatched, []);
  assert.ok(fs.statSync(join(tree, "apps/browser/macos/FakeApp/Delegate.swift")).mtimeMs >= before - 1000);
  assert.ok(fs.statSync(join(tree, "packages/base/ios/run.sh")).mode & 0o100);
  assert.equal(fs.statSync(join(tree, POD_SOURCE)).mtimeMs, old.getTime());
  assert.equal(fs.statSync(join(tree, POD_SOURCE)).ino, keptInode);
  assert.equal(fs.existsSync(join(tree, "packages/base/src")), false);
});

test("a slot file edited after its sync is rewritten from the tree, and removed when the tree deleted it", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  const tree = lib.slotTree(slot);
  const later = new Date(Date.now() + 5000);
  for (const rel of [POD_SOURCE, "apps/browser/macos/Fake.lock"]) {
    fs.writeFileSync(join(tree, rel), "drifted\n");
    fs.utimesSync(join(tree, rel), later, later);
  }
  fs.rmSync(join(src, "apps/browser/macos/Fake.lock"));
  const r = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(r.drifted.sort(), ["apps/browser/macos/Fake.lock", POD_SOURCE]);
  assert.deepEqual(r.changed, [POD_SOURCE]);
  assert.deepEqual(r.removed, ["apps/browser/macos/Fake.lock"]);
  assert.equal(fs.readFileSync(join(tree, POD_SOURCE), "utf8"), "struct Base {}\n");
  assert.equal(fs.existsSync(join(tree, "apps/browser/macos/Fake.lock")), false);
});

test("files an interrupted sync copied stay managed and are removed once the tree no longer has them", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  const tree = lib.slotTree(slot);
  write(tree, "packages/base/ios/Interrupted.mm", "half-synced\n");
  lib.writeSlotState(slot, { ...lib.readSlotState(slot), pending: ["packages/base/ios/Interrupted.mm"] });
  const r = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(r.removed, ["packages/base/ios/Interrupted.mm"]);
  assert.equal(fs.existsSync(join(tree, "packages/base/ios/Interrupted.mm")), false);
  assert.deepEqual(lib.readSlotState(slot).pending, []);
});

test("a file that changes between hashing and copying is reported and left pending", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  const manifest = lib.manifestOf(src, lib.listFiles(src));
  write(src, POD_SOURCE, "edited while syncing\n");
  const r = lib.syncTree(src, slot, manifest);
  assert.deepEqual(r.mismatched, [POD_SOURCE]);
  assert.deepEqual(lib.readSlotState(slot).pending, [POD_SOURCE]);
  assert.ok(!(POD_SOURCE in lib.readSlotState(slot).manifest));
  const again = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(again.mismatched, []);
  assert.ok(again.changed.includes(POD_SOURCE));
});

test("node_modules links that would leave the tree are found, scoped and nested ones included", () => {
  const outside = scratch();
  fs.mkdirSync(join(outside, "pkg"));
  const fine = scratch();
  write(fine, "node_modules/real/package.json", "{}");
  write(fine, "node_modules/real/cli.js", "");
  write(fine, "packages/base/package.json", "{}");
  fs.mkdirSync(join(fine, "node_modules/@scope"), { recursive: true });
  fs.symlinkSync("../../packages/base", join(fine, "node_modules/@scope/base"));
  fs.mkdirSync(join(fine, "node_modules/.bin"));
  fs.symlinkSync("../real/cli.js", join(fine, "node_modules/.bin/real"));
  assert.deepEqual(lib.escapingLinks(fine, { deep: true }), []);

  const scoped = scratch();
  fs.mkdirSync(join(scoped, "node_modules/@scope"), { recursive: true });
  fs.symlinkSync(join(outside, "pkg"), join(scoped, "node_modules/@scope/pkg"));
  assert.equal(lib.escapingLinks(scoped).length, 1);

  const absoluteInside = scratch();
  write(absoluteInside, "node_modules/real/package.json", "{}");
  fs.mkdirSync(join(absoluteInside, "apps/web/node_modules"), { recursive: true });
  fs.symlinkSync(join(absoluteInside, "node_modules/real"), join(absoluteInside, "apps/web/node_modules/real"));
  assert.equal(lib.escapingLinks(absoluteInside).length, 0);
  const relocated = join(scratch(), "slot");
  execFileSync("cp", ["-R", absoluteInside, relocated]);
  assert.equal(lib.escapingLinks(relocated).length, 1);

  const nested = scratch();
  fs.mkdirSync(join(nested, "node_modules/a/node_modules"), { recursive: true });
  fs.symlinkSync("../../../../elsewhere", join(nested, "node_modules/a/node_modules/b"));
  assert.equal(lib.escapingLinks(nested).length, 0);
  assert.equal(lib.escapingLinks(nested, { deep: true }).length, 1);

  const whole = scratch();
  fs.symlinkSync(join(outside, "pkg"), join(whole, "node_modules"));
  assert.equal(lib.escapingLinks(whole).length, 1);
  assert.deepEqual(lib.escapingLinks(scratch()), []);
});

test("a slot under a symlinked slot root is busy by the lock locked takes on its real path", () => {
  const real = scratch();
  const linkParent = scratch();
  const linked = join(linkParent, "slots");
  fs.symlinkSync(real, linked);
  const slot = join(linked, "1");
  fs.mkdirSync(lib.slotDerivedData(slot), { recursive: true });
  const locks = scratch();
  const holder = lib.lockHolderPath(fs.realpathSync(lib.slotDerivedData(slot)), locks);
  fs.writeFileSync(holder, `pid ${process.pid} since now\n`);
  assert.ok(lib.slotBusy(slot, { root: locks }));
  assert.notEqual(lib.lockHolderPath(lib.slotDerivedData(slot), locks), holder);
});

test("the engine is staged into an immutable folder named by its content, so a changed byte is a new path", () => {
  const cache = scratch();
  const source = framework();
  const a = lib.stageEngine(cache, source);
  assert.ok(a.copy.endsWith(`${a.digest.slice(0, 32)}/Chromium Framework.framework`));
  assert.equal(fs.readFileSync(join(a.copy, "Versions/A/Chromium Framework"), "utf8"), "engine");
  assert.equal(lib.stageEngine(cache, source).copy, a.copy);
  const st = fs.statSync(join(source, "Versions/A/Chromium Framework"));
  fs.writeFileSync(join(source, "Versions/A/Chromium Framework"), "Engine");
  fs.utimesSync(join(source, "Versions/A/Chromium Framework"), st.atime, st.mtime);
  const b = lib.stageEngine(cache, source);
  assert.notEqual(b.copy, a.copy);
  assert.equal(fs.readFileSync(join(a.copy, "Versions/A/Chromium Framework"), "utf8"), "engine");
  assert.equal(lib.frameworkIdentity(b.copy), lib.frameworkIdentity(source));
});

test("sync scratch files live in the slot's own folder, which the next sync clears", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  write(slot, "tmp/12345-left-by-a-killed-sync", "partial");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(fs.readdirSync(lib.slotScratch(slot)), []);
  const leftovers = execFileSync("find", [lib.slotTree(slot), "-name", "*.ac-sync-*"], { encoding: "utf8" }).trim();
  assert.equal(leftovers, "");
});

test("a relative node_modules link through another symlink is caught by its real path", () => {
  const outside = scratch();
  fs.mkdirSync(join(outside, "pkg"));
  const root = scratch();
  fs.mkdirSync(join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(outside, join(root, "hop"));
  fs.symlinkSync("../hop/pkg", join(root, "node_modules/pkg"));
  assert.equal(lib.escapingLinks(root).length, 1);
  const dangling = scratch();
  fs.mkdirSync(join(dangling, "node_modules"));
  fs.symlinkSync("./missing", join(dangling, "node_modules/missing"));
  assert.equal(lib.escapingLinks(dangling).length, 1);
});

test("a slot stays busy while any of its recorded process group runs, and nobody signals it", async () => {
  const { spawn } = await import("node:child_process");
  const slot = scratch();
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(lib.slotGroupFile(slot), JSON.stringify({ pgid: child.pid }));
  try {
    assert.equal(lib.settleGroup(slot), true);
    assert.ok(fs.existsSync(lib.slotGroupFile(slot)));
    assert.ok(lib.slotBusy(slot, { root: scratch() }));
    assert.ok(lib.groupAlive(child.pid));
  } finally {
    process.kill(-child.pid, "SIGKILL");
  }
  await new Promise((r) => child.on("exit", r));
  assert.equal(lib.settleGroup(slot), false);
  assert.ok(!fs.existsSync(lib.slotGroupFile(slot)));
  assert.ok(!lib.slotBusy(slot, { root: scratch() }));
});

const CORE_RS = ["packages", "core-rs"].join("/");

test("every Rust core input changes the stamp: crates, lockfile, toolchain file, cargo config, header, build script", () => {
  const dir = repo();
  const files = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "include/ardia_core.h", "scripts/build-xcframework.sh", "crates/ardia-ffi/src/lib.rs"];
  for (const rel of files) write(dir, `${CORE_RS}/${rel}`, `${rel} v1\n`);
  const seen = new Set([stampOf(dir)]);
  for (const rel of files) {
    write(dir, `${CORE_RS}/${rel}`, `${rel} v2\n`);
    const next = stampOf(dir);
    assert.ok(!seen.has(next), rel);
    seen.add(next);
  }
});

test("the Rust toolchain and its environment are in the stamp, and a redirected xcframework turns reuse off", () => {
  const dir = repo();
  const base = stampOf(dir, { rust: "rust rustc 1.100.0 (0ef1bc386 2026-11-09) | cargo 1.100.0" });
  assert.notEqual(stampOf(dir, { rust: "rust rustc 1.101.0 (aaaaaaaaa 2026-12-01) | cargo 1.101.0" }), base);
  assert.notEqual(stampOf(dir, { rust: "rust unavailable" }), base);
  assert.deepEqual(lib.envFingerprint({ RUSTUP_TOOLCHAIN: "nightly", CARGO_HOME: "/h" }).lines, ["env CARGO_HOME=/h", "env RUSTUP_TOOLCHAIN=nightly"]);
  assert.deepEqual(lib.envFingerprint({ CARGO_TARGET_DIR: "/shared/target" }).blocked, ["CARGO_TARGET_DIR"]);
  assert.deepEqual(lib.envFingerprint({ ARDIA_CORE_RS_XCFRAMEWORK: "/elsewhere" }).blocked, ["ARDIA_CORE_RS_XCFRAMEWORK"]);
  const inputs = lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", rust: "rust r" });
  assert.equal(inputs.rust, "rust r");
});

test("the Rust identity reads the toolchain the core pins, and says so when there is no core or no rustc", () => {
  const noCore = scratch();
  assert.equal(lib.rustIdentity(noCore), "rust none");
  const core = scratch();
  write(core, `${CORE_RS}/rust-toolchain.toml`, "[toolchain]\nchannel = \"0.0.0-missing\"\n");
  assert.equal(lib.rustIdentity(core, { PATH: "/nonexistent" }, { toolchain: "xcode x" }), null);
  assert.match(lib.stampInputs({ framework: framework(), env: {}, toolchain: "t", repo: core, rust: null }).blocked, /Rust toolchain/);
});

test("staging resolves a symlinked framework, refuses links that leave it, and replaces a copy that is a symlink", () => {
  const cache = scratch();
  const real = framework();
  const linked = join(scratch(), "Linked.framework");
  fs.symlinkSync(real, linked);
  const staged = lib.stageEngine(cache, linked);
  assert.equal(fs.lstatSync(staged.copy).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(join(staged.copy, "Versions/A/Chromium Framework")).isSymbolicLink(), false);
  fs.writeFileSync(join(real, "Versions/A/Chromium Framework"), "edited after staging");
  assert.equal(fs.readFileSync(join(staged.copy, "Versions/A/Chromium Framework"), "utf8"), "engine");

  const leaky = framework();
  const outside = write(scratch(), "outside.pak", "x");
  fs.symlinkSync(outside, join(leaky, "Versions/A/resources.pak"));
  assert.throws(() => lib.stageEngine(cache, leaky), /links that leave it/);

  const source = framework();
  const first = lib.stageEngine(cache, source);
  fs.rmSync(first.copy, { recursive: true });
  fs.symlinkSync(source, first.copy);
  const again = lib.stageEngine(cache, source);
  assert.equal(again.copy, first.copy);
  assert.equal(fs.lstatSync(again.copy).isSymbolicLink(), false);
});

test("a framework inside the local Chromium tree is recognised by its real path", () => {
  const tree = scratch();
  const fw = join(tree, "out/Release_GN_arm64/Chromium Framework.framework");
  fs.mkdirSync(fw, { recursive: true });
  const link = join(scratch(), "fw");
  fs.symlinkSync(fw, link);
  assert.equal(lib.isInside(fw, tree), true);
  assert.equal(lib.isInside(link, tree), true);
  assert.equal(lib.isInside(framework(), tree), false);
  assert.equal(lib.isInside("/nowhere/at/all", tree), false);
});

test("no wrapped command starts while the slot's recorded process group still runs", async () => {
  const { spawn } = await import("node:child_process");
  const slot = scratch();
  assert.deepEqual(lib.groupCommand(slot, "true", [])?.[0], "perl");
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(lib.slotGroupFile(slot), JSON.stringify({ pgid: child.pid }));
  try {
    assert.equal(lib.groupCommand(slot, "true", []), null);
    assert.equal(JSON.parse(fs.readFileSync(lib.slotGroupFile(slot), "utf8")).pgid, child.pid);
  } finally {
    process.kill(-child.pid, "SIGKILL");
  }
  await new Promise((r) => child.on("exit", r));
  assert.ok(lib.groupCommand(slot, "true", []));
});

test("publishing over an entry whose bytes no longer match its digest replaces it; an intact one is kept", () => {
  const cache = scratch();
  const first = lib.store(cache, S1, fakeApp(scratch(), "abc"), {}, { measure: one });
  fs.writeFileSync(join(first.app, "Contents/MacOS/Ardia"), "xyz");
  assert.equal(lib.snapshotEntry(lib.lookup(cache, S1), join(scratch(), "bad")), null);
  const replaced = lib.store(cache, S1, fakeApp(scratch(), "new"), {}, { measure: one });
  assert.notEqual(replaced.existed, true);
  assert.equal(appText(lib.lookup(cache, S1)), "new");
  assert.ok(lib.snapshotEntry(lib.lookup(cache, S1), join(scratch(), "good")));
  const kept = lib.store(cache, S1, fakeApp(scratch(), "other"), {}, { measure: one });
  assert.equal(kept.existed, true);
  assert.equal(appText(lib.lookup(cache, S1)), "new");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

const fakeRust = (rustc = "rustc 1.100.0 commit-hash: aaa", cargo = "cargo 1.100.0") => (cmd) => (cmd === "rustc" ? rustc : cmd === "cargo" ? cargo : null);

function rustTree() {
  const dir = scratch();
  write(dir, `${CORE_RS}/rust-toolchain.toml`, "[toolchain]\nchannel = \"1.100.0\"\n");
  return dir;
}

test("one Rust build identity covers rustc, cargo, Rust variables, the Cargo home config and Xcode", () => {
  const tree = rustTree();
  const home = scratch();
  const id = (env = {}, opts = {}) => lib.rustIdentity(tree, { CARGO_HOME: home, ...env }, { run: fakeRust(), toolchain: "xcode 27B52", ...opts });
  const base = id();
  assert.ok(base.startsWith("rust | rustc 1.100.0"));
  assert.notEqual(id({}, { run: fakeRust("rustc 1.101.0 commit-hash: bbb") }), base);
  assert.notEqual(id({}, { run: fakeRust(undefined, "cargo 1.101.0") }), base);
  assert.notEqual(id({ RUSTFLAGS: "-Ctarget-cpu=native" }), base);
  assert.notEqual(id({}, { toolchain: "xcode 27C1" }), base);
  write(home, "config.toml", "[build]\njobs = 2\n");
  const withConfig = id();
  assert.notEqual(withConfig, base);
  write(home, "config.toml", "[build]\njobs = 4\n");
  assert.notEqual(id(), withConfig);
  assert.equal(lib.rustIdentity(tree, { CARGO_HOME: home }, { run: () => null, toolchain: "x" }), null);
});

test("the xcframework receipt must name the identity the stamp carries", () => {
  const tree = rustTree();
  assert.equal(lib.receiptMatches(tree, "rust | a"), false);
  lib.writeReceipt(tree, "rust | a");
  assert.equal(lib.receiptMatches(tree, "rust | a"), true);
  assert.equal(lib.receiptMatches(tree, "rust | b"), false);
  assert.equal(lib.receiptMatches(scratch(), "rust | anything"), true);
});

test("slot attempts: every free slot without waiting, then the best one for at most min(60 s, the budget)", () => {
  assert.deepEqual(lib.attemptPlan(["/s/2", "/s/1"], 1500), [{ slot: "/s/2", wait: 1 }, { slot: "/s/1", wait: 1 }, { slot: "/s/2", wait: 60 }]);
  assert.deepEqual(lib.attemptPlan(["/s/2"], 0), [{ slot: "/s/2", wait: 1 }, { slot: "/s/2", wait: 1 }]);
  assert.deepEqual(lib.attemptPlan(["/s/2"], 20), [{ slot: "/s/2", wait: 1 }, { slot: "/s/2", wait: 20 }]);
  assert.deepEqual(lib.attemptPlan([], 1500), []);
});

test("build-app stages the engine, which may take the chromium lock, before it takes its own lock", () => {
  const script = fs.readFileSync(new URL("../agent/build-app", import.meta.url), "utf8");
  const stage = script.indexOf("stage-engine --framework");
  const own = script.indexOf("exec lockf");
  assert.ok(stage > 0 && own > 0 && stage < own);
});

test("a framework link that resolves outside it through another link, or not at all, is refused", () => {
  const outside = scratch();
  write(outside, "pkg/resources.pak", "x");
  const fw = framework();
  fs.symlinkSync(outside, join(fw, "Versions/A/hop"));
  fs.symlinkSync("hop/pkg/resources.pak", join(fw, "Versions/A/resources.pak"));
  assert.ok(lib.linksLeaving(fw).some((l) => l.includes("resources.pak")));
  const dangling = framework();
  fs.symlinkSync("missing", join(dangling, "Versions/A/missing.pak"));
  assert.equal(lib.linksLeaving(dangling).length, 1);
  assert.deepEqual(lib.linksLeaving(framework()), []);
});

test("an occupied entry path with broken metadata or structure is repaired, under a per-stamp lock", () => {
  const cache = scratch();
  write(cache, `${S1}/meta.json`, "not json");
  const a = lib.store(cache, S1, fakeApp(scratch(), "fresh"), {}, { measure: one });
  assert.equal(appText(a), "fresh");
  const b = lib.lookup(cache, S2);
  assert.equal(b, null);
  write(cache, `${S2}/meta.json`, JSON.stringify({ stamp: S2, digest: "d" }));
  assert.equal(appText(lib.store(cache, S2, fakeApp(scratch(), "fixed"), {}, { measure: one })), "fixed");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp") || n.startsWith(".lock")), []);
});

test("the per-stamp lock waits for a live holder and reclaims a dead one", () => {
  const dir = scratch();
  const lock = join(dir, ".lock-x");
  fs.mkdirSync(lock);
  fs.writeFileSync(join(lock, "pid"), String(process.pid));
  assert.deepEqual(lib.withLock(lock, () => 1, { timeoutMs: 200 }), { locked: false });
  fs.writeFileSync(join(lock, "pid"), "999999");
  assert.deepEqual(lib.withLock(lock, () => 2, { timeoutMs: 200 }), { locked: true, value: 2 });
  assert.equal(fs.existsSync(lock), false);
});

test("sync never deletes or writes through a symlinked folder in the slot", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  const tree = lib.slotTree(slot);
  const outside = scratch();
  write(outside, "keep.txt", "not the slot's");
  fs.mkdirSync(join(tree, "packages/base"), { recursive: true });
  fs.symlinkSync(outside, join(tree, "packages/base/ios"));
  lib.writeSlotState(slot, { manifest: {}, pending: ["packages/base/ios/keep.txt"], syncedAt: 0 });
  assert.throws(() => lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src))), /is a symlink in the slot/);
  assert.equal(fs.readFileSync(join(outside, "keep.txt"), "utf8"), "not the slot's");
  const manifest = lib.manifestOf(src, lib.listFiles(src));
  delete manifest[POD_SOURCE];
  lib.writeSlotState(slot, { manifest: {}, pending: ["packages/base/ios/keep.txt"], syncedAt: 0 });
  lib.syncTree(src, slot, manifest);
  assert.equal(fs.readFileSync(join(outside, "keep.txt"), "utf8"), "not the slot's");
});

test("dependency roots under a symlinked apps or packages folder are refused, not scanned or removed", () => {
  const other = scratch();
  write(other, "web/node_modules/pkg/index.js", "theirs");
  const root = scratch();
  write(root, "node_modules/a/index.js", "");
  fs.symlinkSync(other, join(root, "apps"));
  assert.throws(() => lib.nodeModulesRoots(root), /is a symlink/);
  assert.throws(() => lib.escapingLinks(root), /is a symlink/);
  const nested = scratch();
  fs.mkdirSync(join(nested, "packages"));
  fs.symlinkSync(join(other, "web"), join(nested, "packages/web"));
  assert.throws(() => lib.nodeModulesRoots(nested), /is a symlink/);
  assert.deepEqual(lib.nodeModulesRoots(scratch()), []);
});

test("an app is runnable only with its bundle executable in place", () => {
  const app = join(scratch(), "Ardia.app");
  write(app, "Contents/Info.plist", "<plist><dict><key>CFBundleExecutable</key>\n<string>Ardia</string></dict></plist>");
  assert.equal(lib.appRunnable(app), false);
  write(app, "Contents/MacOS/Ardia", "bin", 0o755);
  assert.equal(lib.appRunnable(app), true);
  fs.chmodSync(join(app, "Contents/MacOS/Ardia"), 0o644);
  assert.equal(lib.appRunnable(app), false);
  assert.equal(lib.appRunnable(join(scratch(), "None.app")), false);
});

test("a slot taken after the eviction list was made is not dropped", async () => {
  const { spawn } = await import("node:child_process");
  const slot = scratch();
  assert.equal(lib.slotDroppable(slot), true);
  fs.writeFileSync(join(slot, "reserved.json"), JSON.stringify({ pid: process.pid }));
  assert.equal(lib.slotDroppable(slot), false);
  fs.rmSync(join(slot, "reserved.json"));
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(lib.slotGroupFile(slot), JSON.stringify({ pgid: child.pid }));
  try {
    assert.equal(lib.slotDroppable(slot), false);
  } finally {
    process.kill(-child.pid, "SIGKILL");
  }
  await new Promise((r) => child.on("exit", r));
  assert.equal(lib.slotDroppable(slot), true);
});

test("an engine protected by its full path survives eviction with no room and no grace", () => {
  const cache = scratch();
  for (const key of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) write(cache, `engines/${key}/.complete`, "");
  lib.evict(cache, { maxBytes: 100, maxEntries: 10, keepEngines: 0, graceMs: 0, protectEngines: [`${join(cache, "engines", "aaaaaaaaaaaa")}/`] });
  assert.deepEqual(fs.readdirSync(join(cache, "engines")), ["aaaaaaaaaaaa"]);
});

test("a folder where the slot had a file counts as drift instead of failing the sync", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  const path = join(lib.slotTree(slot), POD_SOURCE);
  fs.rmSync(path);
  fs.mkdirSync(path);
  write(path, "inner.txt", "x");
  assert.deepEqual(lib.driftedPaths(lib.slotTree(slot), lib.readSlotState(slot)), [POD_SOURCE]);
  const r = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.ok(r.changed.includes(POD_SOURCE));
  assert.equal(fs.readFileSync(path, "utf8"), "struct Base {}\n");
});

test("a Release restore in a tree without node_modules is a miss, so build-app builds instead", async () => {
  const { spawnSync } = await import("node:child_process");
  const cache = scratch();
  const app = join(scratch(), "Ardia.app");
  write(app, "Contents/MacOS/Ardia", "bin", 0o755);
  lib.store(cache, S1, app, { config: "Release" }, { measure: one });
  const tree = scratch();
  const cli = new URL("../agent/build-cache", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "restore", "--repo", tree, "--stamp", S1, "--config", "Release", "--out", join(scratch(), "out")], {
    encoding: "utf8",
    env: { ...process.env, AC_APP_CACHE: cache },
  });
  assert.equal(r.status, 2, r.stderr);
});
