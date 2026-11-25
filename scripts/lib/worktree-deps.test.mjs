import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CACHE_STAMP,
  GUARD_FILE,
  GUARD_SOURCE,
  MARKER,
  USERS_DIR,
  buildCache,
  dependencyKey,
  installInputs,
  normalizeLockfile,
  planLinks,
  pruneCaches,
  gitLine,
  markerState,
  removeTree,
  runtimeOf,
  setupWorktree,
  undoWorktree,
  withKernelLock,
  parseArgs,
  workspacePatterns,
  workspaceProjects,
  worktreeStatus,
} from "./worktree-deps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "worktree-deps-")));
test.after(() => removeTree(root));

const ENV_DOC = "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        version: 12.21.0\n\n";
const MAIN_DOC = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n";
const LOCKFILE = `${ENV_DOC}---\n${MAIN_DOC}`;
const WORKSPACE = 'packages:\n  - apps/*\n  - packages/*\n  - "!apps/docs"\n\nnodeLinker: hoisted\n';
const PROJECTS = ["apps/web", "apps/docs", "packages/base", "packages/kit"];
const RUNTIME = "darwin-arm64-node24";

const write = (file, text = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
let serial = 0;
const fresh = (name) => path.join(root, `${name}-${serial++}`);
const quiet = () => {};
const lstatOrNullForTest = (file) => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};

function makeWorktree({ patch = "patch v1\n" } = {}) {
  const dir = fresh("worktree");
  write(path.join(dir, "package.json"), '{"name":"ardia","private":true}');
  write(path.join(dir, "pnpm-lock.yaml"), LOCKFILE);
  write(path.join(dir, "pnpm-workspace.yaml"), WORKSPACE);
  write(path.join(dir, "patches", "left-pad@1.0.0.patch"), patch);
  for (const project of PROJECTS) write(path.join(dir, project, "package.json"), `{"name":"@ardia/${path.basename(project)}"}`);
  return dir;
}

function fakeInstall(dir) {
  const nm = path.join(dir, "node_modules");
  write(path.join(nm, ".pnpm", "lock.yaml"), normalizeLockfile(fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8")));
  write(path.join(nm, ".modules.yaml"), "layoutVersion: 5\n");
  write(path.join(nm, ".cache", "stale"), "x");
  write(path.join(nm, "react", "index.js"), "module.exports = 'react from the tree';\n");
  write(path.join(nm, "@babel", "core", "package.json"), '{"name":"@babel/core"}');
  write(path.join(nm, "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(nm, ".bin"), { recursive: true });
  fs.symlinkSync("../typescript/bin/tsc", path.join(nm, ".bin", "tsc"));
  fs.mkdirSync(path.join(nm, "@ardia"), { recursive: true });
  for (const project of ["apps/web", "packages/base", "packages/kit"]) fs.symlinkSync(`../../${project}`, path.join(nm, "@ardia", path.basename(project)));
  write(path.join(dir, "apps", "web", "node_modules", "react-refresh", "package.json"), '{"name":"react-refresh"}');
  fs.mkdirSync(path.join(dir, "apps", "web", "node_modules", "@ardia"), { recursive: true });
  fs.symlinkSync("../../../../packages/base", path.join(dir, "apps", "web", "node_modules", "@ardia", "base"));
}

function harness() {
  const cacheRoot = fresh("cache");
  const installs = [];
  const install = (staging) => {
    installs.push(staging);
    fakeInstall(staging);
  };
  const build = ({ worktree, cacheRoot: cache, runtime }) => buildCache({ worktree, cacheRoot: cache, runtime, install });
  const home = fresh("home");
  const setup = (worktree, extra = {}) => setupWorktree(worktree, { cacheRoot, build, runtime: RUNTIME, log: quiet, home, ...extra });
  return { cacheRoot, installs, setup };
}

const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "f"}`)
    .sort()
    .join("\n");

test("pnpm's installed lockfile reads as the worktree's once the package-manager document is set aside", () => {
  assert.equal(normalizeLockfile(LOCKFILE), MAIN_DOC);
  assert.equal(normalizeLockfile(MAIN_DOC), MAIN_DOC);
});

test("the key covers every install input: lockfile, .npmrc, workspace settings, each manifest, patches and runtime", () => {
  const dir = makeWorktree();
  const key = () => dependencyKey(installInputs(dir, RUNTIME));
  const base = key();
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(dependencyKey({ ...installInputs(dir, RUNTIME), files: [...installInputs(dir, RUNTIME).files].reverse() }), base);
  write(path.join(dir, "apps", "docs", "package.json"), '{"name":"@ardia/docs","dependencies":{"astro":"5"}}');
  assert.equal(key(), base, "a project outside the workspace isn't an input");
  const changes = [
    [() => write(path.join(dir, "pnpm-lock.yaml"), `${ENV_DOC.replace("12.21.0", "12.22.0")}---\n${MAIN_DOC}`), "the package-manager document"],
    [() => write(path.join(dir, ".npmrc"), "node-linker=isolated\n"), ".npmrc"],
    [() => write(path.join(dir, "pnpm-workspace.yaml"), WORKSPACE.replace("hoisted", "isolated")), "workspace settings"],
    [() => write(path.join(dir, "package.json"), '{"name":"ardia","scripts":{"postinstall":"node x"}}'), "the root manifest"],
    [() => write(path.join(dir, "packages", "kit", "package.json"), '{"name":"@ardia/kit","dependencies":{"left-pad":"1"}}'), "a workspace manifest"],
    [() => write(path.join(dir, "patches", "left-pad@1.0.0.patch"), "patch v2\n"), "a patch"],
    [() => write(path.join(dir, "patches", "other@1.0.0.patch"), "new\n"), "a new patch"],
  ];
  let previous = base;
  for (const [change, what] of changes) {
    change();
    const next = key();
    assert.notEqual(next, previous, what);
    previous = next;
  }
  assert.notEqual(dependencyKey(installInputs(dir, "linux-x64-node24")), previous, "the platform and CPU");
  assert.notEqual(dependencyKey(installInputs(dir, "darwin-arm64-node26")), previous, "the Node major version");
  assert.equal(runtimeOf({ platform: "darwin", arch: "arm64", versions: { node: "24.22.2" } }), "darwin-arm64-node24");
});

test("workspace projects follow pnpm-workspace.yaml, negations included", () => {
  assert.deepEqual(workspacePatterns(WORKSPACE), ["apps/*", "packages/*", "!apps/docs"]);
  const dir = makeWorktree();
  fs.mkdirSync(path.join(dir, "packages", "no-manifest"), { recursive: true });
  assert.deepEqual(workspaceProjects(dir, WORKSPACE), ["", "apps/web", "packages/base", "packages/kit"]);
});

test("link plan: entries link to the tree, pnpm state and caches stay out, @ardia points into the worktree", () => {
  const entries = [
    { name: ".bin", kind: "dir" },
    { name: ".cache", kind: "dir" },
    { name: ".modules.yaml", kind: "file" },
    { name: ".pnpm", kind: "dir" },
    { name: "@ardia", kind: "workspace-scope", links: [{ name: "base", link: "../../../../packages/base" }, { name: "gone", link: "../../../../packages/gone" }, { name: "out", link: "../../../../../elsewhere" }] },
    { name: "@babel", kind: "dir" },
    { name: "react", kind: "dir" },
  ];
  const { ops, warnings } = planLinks({ sourceRoot: "/tree", worktreeRoot: "/wt", project: "apps/web", entries, exists: (p) => p === "/wt/packages/base" });
  assert.deepEqual(ops, [
    { type: "mkdir", path: "/wt/apps/web/node_modules" },
    { type: "symlink", path: "/wt/apps/web/node_modules/.bin", target: "/tree/apps/web/node_modules/.bin" },
    { type: "mkdir", path: "/wt/apps/web/node_modules/@ardia" },
    { type: "symlink", path: "/wt/apps/web/node_modules/@ardia/base", target: "../../../../packages/base" },
    { type: "symlink", path: "/wt/apps/web/node_modules/@babel", target: "/tree/apps/web/node_modules/@babel" },
    { type: "symlink", path: "/wt/apps/web/node_modules/react", target: "/tree/apps/web/node_modules/react" },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /no packages\/gone/);
  assert.match(warnings[1], /outside its tree/);
});

test("setup installs once per key into a read-only cache, links the worktree into it, and records the worktree", () => {
  const { cacheRoot, installs, setup } = harness();
  const first = makeWorktree();
  const result = setup(first);
  assert.equal(result.createdCache, true);
  assert.equal(installs.length, 1);
  assert.equal(result.sourceRoot, path.join(fs.realpathSync(cacheRoot), result.key));
  const stamp = JSON.parse(fs.readFileSync(path.join(result.sourceRoot, CACHE_STAMP), "utf8"));
  assert.equal(stamp.key, result.key);
  assert.equal(stamp.runtime, RUNTIME);
  assert.ok(stamp.files[".npmrc"] === undefined && stamp.files["packages/kit/package.json"], "the stamp records the inputs it was built from");
  assert.deepEqual(result.projects, ["", "apps/web"]);
  assert.equal(fs.readlinkSync(path.join(first, "node_modules", "react")), path.join(result.sourceRoot, "node_modules", "react"));
  assert.equal(fs.realpathSync(path.join(first, "node_modules", ".bin", "tsc")), path.join(result.sourceRoot, "node_modules", "typescript", "bin", "tsc"));
  assert.equal(fs.realpathSync(path.join(first, "node_modules", "@ardia", "base")), path.join(first, "packages", "base"));
  assert.equal(fs.realpathSync(path.join(first, "apps", "web", "node_modules", "@ardia", "base")), path.join(first, "packages", "base"));
  for (const local of [".cache", ".pnpm", ".modules.yaml"]) assert.ok(!fs.existsSync(path.join(first, "node_modules", local)), local);
  assert.ok(!fs.existsSync(path.join(first, "apps", "docs", "node_modules")), "apps/docs is outside the workspace");
  if (process.getuid?.() !== 0) {
    assert.throws(() => fs.writeFileSync(path.join(first, "node_modules", "react", "index.js"), "through the link"), { code: "EACCES" });
    assert.throws(() => fs.mkdirSync(path.join(first, "node_modules", "@babel", "new-package")), { code: "EACCES" });
  }
  assert.equal(fs.readFileSync(path.join(first, GUARD_FILE), "utf8"), GUARD_SOURCE);
  assert.ok(fs.existsSync(path.join(first, ".metadata_never_index")));
  assert.equal(fs.readdirSync(path.join(cacheRoot, USERS_DIR)).length, 1);
  assert.deepEqual(fs.readdirSync(cacheRoot).filter((n) => n.startsWith(".staging")), []);
  assert.deepEqual(worktreeStatus(first, { runtime: RUNTIME }).problems, []);

  const again = setup(makeWorktree());
  assert.equal(again.sourceRoot, result.sourceRoot);
  assert.equal(again.createdCache, false);
  assert.equal(installs.length, 1);
  assert.equal(setup(makeWorktree({ patch: "patch v2\n" })).createdCache, true);
  assert.equal(installs.length, 2);
});

test("a relative --cache works", () => {
  const { setup } = harness();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const result = setup(makeWorktree(), { cacheRoot: "relative-cache" });
    assert.equal(result.sourceRoot, path.join(root, "relative-cache", result.key));
  } finally {
    process.chdir(cwd);
  }
});

test("setup refuses someone else's pnpmfile before changing anything, and undo keeps a pnpmfile it didn't write", () => {
  const { cacheRoot, installs, setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, GUARD_FILE), "module.exports = { hooks: {} };\n");
  assert.throws(() => setup(worktree), /someone else's pnpmfile/);
  assert.equal(installs.length, 0);
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules")));
  assert.ok(!fs.existsSync(path.join(cacheRoot, USERS_DIR)));
  write(path.join(worktree, GUARD_FILE), 'function blocked() {\n  throw new Error("pnpm install is blocked in a worktree linked by scripts/agent/worktree-setup");\n}\n');
  setup(worktree);
  assert.equal(fs.readFileSync(path.join(worktree, GUARD_FILE), "utf8"), GUARD_SOURCE, "an older guard of ours is replaced");
  setup(worktree);
  write(path.join(worktree, GUARD_FILE), "edited by hand\n");
  undoWorktree(worktree, { log: quiet });
  assert.equal(fs.readFileSync(path.join(worktree, GUARD_FILE), "utf8"), "edited by hand\n");
});

test("setup refuses a worktree's own node_modules unless --replace, and reruns in place", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "node_modules", "real-install", "index.js"), "x");
  assert.throws(() => setup(worktree), /its own install; pass --replace/);
  const elsewhere = fresh("whole-tree");
  write(path.join(elsewhere, "react", "index.js"), "x");
  const whole = makeWorktree();
  fs.symlinkSync(elsewhere, path.join(whole, "node_modules"));
  assert.throws(() => setup(whole), /link to a whole node_modules/);
  const before = snapshot(elsewhere);
  setup(whole, { replace: true });
  assert.equal(snapshot(elsewhere), before, "replacing a whole-folder link never deletes through it");
  assert.ok(fs.lstatSync(path.join(whole, "node_modules")).isDirectory());

  const result = setup(worktree, { replace: true });
  write(path.join(worktree, "apps", "web", "node_modules", ".cache", "ardia-test-tsx", "a.mjs"), "cached");
  write(path.join(worktree, "node_modules", "react_pacquet-stage_1", "index.js"), "left by a bypassed pnpm install");
  fs.rmSync(path.join(worktree, "node_modules", "@babel"));
  write(path.join(worktree, "node_modules", "@babel", "core", "index.js"), "a real copy");
  setup(worktree);
  assert.ok(fs.existsSync(path.join(worktree, "apps", "web", "node_modules", ".cache", "ardia-test-tsx", "a.mjs")), "local caches survive a rerun");
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules", "react_pacquet-stage_1")));
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules", "@babel")).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules", "react")), path.join(result.sourceRoot, "node_modules", "react"));
});

test("the marker names every managed folder before the first link, so undo cleans an interrupted setup", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(makeWorktree());
  const realSymlink = fs.symlinkSync;
  let seen = null;
  t.mock.method(fs, "symlinkSync", (target, file) => {
    seen ??= JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", MARKER), "utf8"));
    if (file.includes(`${path.sep}apps${path.sep}web${path.sep}`)) throw new Error("interrupted");
    return realSymlink(target, file);
  });
  assert.throws(() => setup(worktree), /interrupted/);
  t.mock.restoreAll();
  assert.deepEqual(seen.projects, ["", "apps/web"]);
  assert.equal(seen.state, "linking");
  assert.match(worktreeStatus(worktree, { runtime: RUNTIME }).problems.join("\n"), /didn't finish/);
  undoWorktree(worktree, { log: quiet });
  for (const gone of ["node_modules", "apps/web/node_modules", GUARD_FILE]) assert.ok(!fs.existsSync(path.join(worktree, gone)), gone);
});

test("re-setup removes the links of a project the workspace no longer lists", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  assert.deepEqual(setup(worktree).projects, ["", "apps/web"]);
  write(path.join(worktree, "pnpm-workspace.yaml"), WORKSPACE.replace('"!apps/docs"', '"!apps/docs"\n  - "!apps/web"'));
  const result = setup(worktree);
  assert.deepEqual(result.projects, [""]);
  assert.ok(!fs.existsSync(path.join(worktree, "apps", "web", "node_modules")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", MARKER), "utf8")).projects, [""]);
});

test("status notices changed inputs, and undo removes the worktree's links and record but not the tree", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const result = setup(worktree);
  write(path.join(worktree, ".npmrc"), "save-exact=true\n");
  assert.match(worktreeStatus(worktree, { runtime: RUNTIME }).problems.join("\n"), /install inputs changed/);
  const before = snapshot(result.sourceRoot);
  undoWorktree(worktree, { log: quiet });
  for (const gone of ["node_modules", "apps/web/node_modules", GUARD_FILE]) assert.ok(!fs.existsSync(path.join(worktree, gone)), gone);
  assert.equal(snapshot(result.sourceRoot), before);
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, USERS_DIR)), []);
  assert.throws(() => undoWorktree(worktree, { log: quiet }), /isn't linked/);
});

test("prune keeps a cache any recorded worktree or scratch export still links, git worktree or not", () => {
  const { cacheRoot, setup } = harness();
  const exported = makeWorktree({ patch: "export\n" });
  const exportKey = setup(exported).key;
  const idle = makeWorktree({ patch: "idle\n" });
  const idleKey = setup(idle).key;
  undoWorktree(idle, { log: quiet });
  const moved = makeWorktree({ patch: "moved\n" });
  const movedKey = setup(moved).key;
  undoWorktree(moved, { log: quiet });
  setup(moved, { replace: true });
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: Date.now(), log: quiet }), []);
  const removed = pruneCaches({ cacheRoot, now: later, log: quiet });
  assert.deepEqual(removed, [path.join(cacheRoot, idleKey)]);
  assert.ok(fs.existsSync(path.join(cacheRoot, exportKey, CACHE_STAMP)));
  assert.ok(fs.existsSync(path.join(cacheRoot, movedKey, CACHE_STAMP)));
  assert.equal(fs.readlinkSync(path.join(exported, "node_modules", "react")).startsWith(fs.realpathSync(cacheRoot)), true);
  assert.ok(fs.existsSync(path.join(exported, "node_modules", "react", "index.js")));
});

const childLock = (lockFile, holdMs) =>
  spawn(process.execPath, ["--input-type=module", "-e", `import { withKernelLock } from ${JSON.stringify(path.join(here, "worktree-deps.mjs"))}; withKernelLock(${JSON.stringify(lockFile)}, () => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs}); });`], { stdio: ["ignore", "pipe", "inherit"] });
const held = (child) =>
  new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("held") && resolve());
    child.on("exit", (code, signal) => reject(new Error(`the lock child exited (${code ?? signal}) before it held the lock`)));
  });

test("the kernel lock admits one holder at a time and frees itself when its holder dies", async (t) => {
  const lockFile = path.join(fresh("lock"), "registry.lock");
  assert.equal(withKernelLock(lockFile, () => 7), 7);
  const holder = childLock(lockFile, 1500);
  await held(holder);
  const started = Date.now();
  assert.throws(() => withKernelLock(lockFile, () => 1, { waitSeconds: 0 }), /still held/);
  assert.equal(withKernelLock(lockFile, () => 2), 2);
  assert.ok(Date.now() - started >= 900, "waited for the holder");
  const blocker = childLock(lockFile, 600000);
  t.after(() => blocker.kill("SIGKILL"));
  await held(blocker);
  const waiter = childLock(lockFile, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  waiter.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const perls = spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.startsWith("perl") && line.includes(lockFile));
  assert.equal(perls.length, 1, "a killed waiter's lock child exits instead of polling on");
  blocker.kill("SIGKILL");
  await new Promise((resolve) => blocker.on("close", resolve));
  const crashed = childLock(lockFile, 60000);
  await held(crashed);
  crashed.kill("SIGKILL");
  await new Promise((resolve) => crashed.on("close", resolve));
  const again = Date.now();
  assert.equal(withKernelLock(lockFile, () => 3, { waitSeconds: 5 }), 3);
  assert.ok(Date.now() - again < 2000, "a dead holder's lock is free at once");
});

test("a failed re-setup keeps its old cache claimed, so prune never deletes what the worktree still links", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const first = setup(worktree);
  write(path.join(worktree, "patches", "left-pad@1.0.0.patch"), "patch v2\n");
  assert.throws(() => setup(worktree, { build: () => { throw new Error("build failed"); } }), /build failed/);
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), []);
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "react", "index.js")));
  const second = setup(worktree);
  assert.notEqual(second.key, first.key);
  const record = JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, fs.readdirSync(path.join(cacheRoot, USERS_DIR))[0]), "utf8"));
  assert.deepEqual(record.keys, [second.key], "the old claim goes once the marker names the new cache");
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), [path.join(cacheRoot, first.key)]);
});

test("prune holds the registry lock throughout, a claim needs the cache to still be there, and a vanished record is skipped", (t) => {
  const { cacheRoot, setup } = harness();
  const kept = makeWorktree();
  const result = setup(kept);
  let probed = false;
  const realLstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...rest) => {
    if (!probed && String(file).endsWith(CACHE_STAMP)) {
      probed = true;
      assert.throws(() => withKernelLock(path.join(cacheRoot, ".registry.lock"), () => 0, { waitSeconds: 0 }), /still held/);
    }
    return realLstat(file, ...rest);
  });
  const realRead = fs.readFileSync;
  let vanished = false;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (!vanished && String(file).includes(`${USERS_DIR}${path.sep}`)) {
      vanished = true;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    return realRead(file, ...rest);
  });
  write(path.join(cacheRoot, "0000000000000000", CACHE_STAMP), "{}");
  pruneCaches({ cacheRoot, log: quiet });
  t.mock.restoreAll();
  assert.ok(probed && vanished);
  assert.throws(() => setup(makeWorktree({ patch: "never built\n" }), { build: () => {} }), /didn't publish/);
  assert.ok(fs.existsSync(path.join(cacheRoot, result.key, CACHE_STAMP)));
});

test("setup holds the registry lock from its claim until the marker names the new cache", (t) => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const realSymlink = fs.symlinkSync;
  let checked = 0;
  t.mock.method(fs, "symlinkSync", (...args) => {
    if (String(args[1]).startsWith(worktree) && checked++ === 0) assert.throws(() => withKernelLock(path.join(cacheRoot, ".registry.lock"), () => 0, { waitSeconds: 0 }), /still held/);
    return realSymlink(...args);
  });
  setup(worktree);
  t.mock.restoreAll();
  assert.ok(checked > 0);
  assert.equal(withKernelLock(path.join(cacheRoot, ".registry.lock"), () => "free", { waitSeconds: 0 }), "free");
});

test("a git worktree's claim follows it through git worktree move, even when another worktree takes its old path", () => {
  const { cacheRoot, setup } = harness();
  const repo = fresh("repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  const scratch = makeWorktree();
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) fs.cpSync(path.join(scratch, name), path.join(repo, name), { recursive: true });
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const place = path.join(fresh("wt"), "place");
  git("worktree", "add", "-q", "-b", "a", place);
  const a = setup(place);
  const moved = path.join(path.dirname(place), "moved");
  assert.equal(git("worktree", "move", place, moved).status, 0);
  git("worktree", "add", "-q", "-b", "b", place);
  write(path.join(place, "patches", "left-pad@1.0.0.patch"), "b's own patch\n");
  const b = setup(place);
  assert.notEqual(a.key, b.key);
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), []);
  assert.ok(fs.existsSync(path.join(moved, "node_modules", "react", "index.js")));
  assert.ok(fs.existsSync(path.join(place, "node_modules", "react", "index.js")));
  const records = fs.readdirSync(path.join(cacheRoot, USERS_DIR)).map((name) => JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, name), "utf8")));
  assert.equal(records.length, 2);
  for (const record of records) assert.ok(fs.existsSync(record.gitDir), "each record names its worktree's own git dir");
});

const gitIn = (cwd, ...args) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8" });
function gitRepo(dir) {
  const scratch = makeWorktree();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) fs.cpSync(path.join(scratch, name), path.join(dir, name), { recursive: true });
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}
const LATER = () => Date.now() + 10 * 24 * 60 * 60 * 1000;

test("a git worktree moved while prune runs keeps its cache", (t) => {
  const { cacheRoot, setup } = harness();
  const repo = gitRepo(fresh("repo"));
  const place = path.join(fresh("wt"), "place");
  gitIn(repo, "worktree", "add", "-q", place);
  setup(place);
  const moved = path.join(path.dirname(place), "moved");
  const realRead = fs.readFileSync;
  let done = false;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    const out = realRead(file, ...rest);
    if (!done && String(file).includes(`${USERS_DIR}${path.sep}`)) {
      done = true;
      assert.equal(gitIn(repo, "worktree", "move", place, moved).status, 0);
    }
    return out;
  });
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), []);
  t.mock.restoreAll();
  assert.ok(done);
  assert.ok(fs.existsSync(path.join(moved, "node_modules", "react", "index.js")));
});

test("a submodule and a --separate-git-dir checkout keep their caches while their git dirs exist", () => {
  const { cacheRoot, setup } = harness();
  const superproject = gitRepo(fresh("super"));
  const source = gitRepo(fresh("module-source"));
  write(path.join(source, "patches", "left-pad@1.0.0.patch"), "module patch\n");
  gitIn(source, "commit", "-qam", "module");
  assert.equal(gitIn(superproject, "submodule", "add", "-q", source, "mod").status, 0);
  const submodule = path.join(superproject, "mod");
  const separate = fresh("separate");
  const separateGit = `${separate}.git`;
  fs.mkdirSync(separate);
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) fs.cpSync(path.join(superproject, name), path.join(separate, name));
  write(path.join(separate, "patches", "left-pad@1.0.0.patch"), "separate patch\n");
  assert.equal(gitIn(root, "init", "-q", "--separate-git-dir", separateGit, separate).status, 0);
  const keys = [setup(submodule).key, setup(separate).key];
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), []);
  for (const dir of [submodule, separate]) assert.ok(fs.existsSync(path.join(dir, "node_modules", "react", "index.js")), dir);
  removeTree(separateGit);
  removeTree(separate);
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), [path.join(cacheRoot, keys[1])], "proven dead once its git dir and checkout are gone");
});

test("prune keeps a cache whose claim it can't judge and stops on a record it can't read", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const { key } = setup(worktree);
  fs.writeFileSync(path.join(worktree, "node_modules", MARKER), "{ not json");
  assert.deepEqual(markerState(worktree), { unknown: true });
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), []);
  assert.deepEqual(markerState(fresh("nowhere")), { absent: true });
  write(path.join(cacheRoot, USERS_DIR, "broken.json"), "{");
  assert.throws(() => pruneCaches({ cacheRoot, now: LATER(), log: quiet }), /pruned nothing/);
  assert.ok(fs.existsSync(path.join(cacheRoot, key, CACHE_STAMP)));
});

test("a marker that parses but isn't valid keeps every claim; a valid marker naming another cache proves the claim dead", () => {
  const { cacheRoot, setup } = harness();
  const exported = makeWorktree();
  const { key } = setup(exported);
  const markerFile = path.join(exported, "node_modules", MARKER);
  const good = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  for (const bad of [{}, null, [], { key }, { ...good, root: "relative/path" }, { ...good, key: "not-a-key" }, { ...good, projects: "x" }]) {
    fs.writeFileSync(markerFile, JSON.stringify(bad));
    assert.deepEqual(markerState(exported), { unknown: true }, JSON.stringify(bad));
    assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), [], JSON.stringify(bad));
  }
  fs.writeFileSync(markerFile, JSON.stringify(good));
  assert.deepEqual(markerState(exported), { key });
  const other = "0123456789abcdef";
  fs.writeFileSync(markerFile, JSON.stringify({ ...good, key: other, root: path.join(path.dirname(good.root), other) }));
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), [path.join(cacheRoot, key)]);
});

test("--replace keeps the worktree's own install until the replacement cache is built", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "node_modules", "real-install", "index.js"), "mine");
  write(path.join(worktree, "apps", "web", "node_modules", "local", "index.js"), "mine too");
  assert.throws(() => setup(worktree, { replace: true, build: () => { throw new Error("build failed"); } }), /build failed/);
  assert.equal(fs.readFileSync(path.join(worktree, "node_modules", "real-install", "index.js"), "utf8"), "mine");
  assert.ok(fs.existsSync(path.join(worktree, "apps", "web", "node_modules", "local", "index.js")));
  assert.throws(() => setup(worktree, { replace: true, build: () => {} }), /didn't publish/);
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "real-install", "index.js")));
  setup(worktree, { replace: true });
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules", "real-install")));
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules", "react")).isSymbolicLink());
});

test("git output loses exactly one final newline, so a path ending in a carriage return works", () => {
  assert.equal(gitLine("/a/b\n"), "/a/b");
  assert.equal(gitLine("/a/b\r\n"), "/a/b\r");
  assert.equal(gitLine("/a/b \n"), "/a/b ");
  assert.equal(gitLine("/a/b"), "/a/b");
  const { cacheRoot, setup } = harness();
  const repo = gitRepo(path.join(fresh("cr"), "repo\r"));
  setup(repo);
  const [record] = fs.readdirSync(path.join(cacheRoot, USERS_DIR)).map((name) => JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, name), "utf8")));
  assert.equal(record.gitDir, path.join(fs.realpathSync(repo), ".git"));
});

test("a checkout whose path ends in a space is set up as a git worktree", () => {
  const { cacheRoot, setup } = harness();
  const repo = gitRepo(path.join(fresh("spaced"), "repo "));
  setup(repo);
  const [record] = fs.readdirSync(path.join(cacheRoot, USERS_DIR)).map((name) => JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, name), "utf8")));
  assert.equal(record.gitDir, path.join(fs.realpathSync(repo), ".git"));
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "react", "index.js")));
});

test("a scratch export is recorded by its path", () => {
  const { cacheRoot, setup } = harness();
  const exported = makeWorktree();
  setup(exported);
  const [record] = fs.readdirSync(path.join(cacheRoot, USERS_DIR)).map((name) => JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, name), "utf8")));
  assert.equal(record.gitDir, null);
  assert.equal(record.worktree, exported);
  assert.equal(record.id, `path:${exported}`);
});

test("raw patch bytes key and stage exactly", () => {
  const { setup } = harness();
  const a = makeWorktree();
  const b = makeWorktree();
  fs.writeFileSync(path.join(a, "patches", "left-pad@1.0.0.patch"), Buffer.from([0x80]));
  fs.writeFileSync(path.join(b, "patches", "left-pad@1.0.0.patch"), Buffer.from([0x81]));
  assert.notEqual(dependencyKey(installInputs(a, RUNTIME)), dependencyKey(installInputs(b, RUNTIME)));
  const result = setup(a);
  assert.deepEqual([...fs.readFileSync(path.join(result.sourceRoot, "patches", "left-pad@1.0.0.patch"))], [0x80]);
});

test("every workspace project's node_modules is made read-only, literal and deeper ones too", () => {
  const { cacheRoot } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "pnpm-workspace.yaml"), WORKSPACE.replace("packages:\n", "packages:\n  - tools/deep/gen\n"));
  write(path.join(worktree, "tools", "deep", "gen", "package.json"), '{"name":"@ardia/gen"}');
  const result = setupWorktree(worktree, {
    cacheRoot,
    runtime: RUNTIME,
    log: quiet,
    home: fresh("home"),
    build: ({ worktree: from, cacheRoot: cache, runtime }) =>
      buildCache({ worktree: from, cacheRoot: cache, runtime, install: (staging) => {
        fakeInstall(staging);
        write(path.join(staging, "tools", "deep", "gen", "node_modules", "esbuild", "index.js"), "x");
      } }),
  });
  assert.ok(result.projects.includes("tools/deep/gen"));
  if (process.getuid?.() !== 0) assert.throws(() => fs.mkdirSync(path.join(result.sourceRoot, "tools", "deep", "gen", "node_modules", "new")), { code: "EACCES" });
});

test("prune leaves staging folders alone; a build, under the pod lock, clears leftover ones", () => {
  const { cacheRoot, setup } = harness();
  setup(makeWorktree());
  const leftover = path.join(cacheRoot, ".staging-0000000000000000-1");
  write(path.join(leftover, "node_modules", "x"), "x");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(leftover, old, old);
  pruneCaches({ cacheRoot, now: Date.now() + 10 * 24 * 60 * 60 * 1000, log: quiet });
  assert.ok(fs.existsSync(leftover));
  setup(makeWorktree({ patch: "new key\n" }));
  assert.ok(!fs.existsSync(leftover));
});

test("the cache is installed from the exact bytes its key was computed from", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).includes(".staging-") && String(file).endsWith(".patch")) realWrite(path.join(worktree, "patches", "left-pad@1.0.0.patch"), "edited after hashing\n");
    return realWrite(file, ...rest);
  });
  const result = setup(worktree);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(result.sourceRoot, "patches", "left-pad@1.0.0.patch"), "utf8"), "patch v1\n");
  assert.equal(dependencyKey(installInputs(result.sourceRoot, RUNTIME)), result.key);
});

const hasLock = spawnSync("sh", ["-c", "command -v lockf || command -v flock"]).status === 0;

test("concurrent setups on one new key build it once under the pod lock, and exclude rules aren't duplicated", { skip: !hasLock && "no lockf or flock" }, async () => {
  const dir = fresh("concurrent");
  const bin = path.join(dir, "bin");
  write(path.join(bin, "pnpm"), `#!/bin/sh\necho install >> "${dir}/installs"\nmkdir -p node_modules/.pnpm node_modules/x && cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml && echo 1 > node_modules/x/index.js\nsleep 1\n`);
  fs.chmodSync(path.join(bin, "pnpm"), 0o755);
  fs.mkdirSync(path.join(dir, "locks"));
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "-q", repo]);
  const worktrees = [0, 1, 2].map((n) => {
    const worktree = path.join(repo, `w${n}`);
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) write(path.join(worktree, file), file === "pnpm-lock.yaml" ? LOCKFILE : file === "package.json" ? "{}" : "packages: []\n");
    return worktree;
  });
  fs.mkdirSync(path.join(dir, "home"));
  const env = { ...process.env, HOME: path.join(dir, "home"), PATH: `${bin}${path.delimiter}${process.env.PATH}`, AC_LOCK_ROOT: path.join(dir, "locks") };
  const cli = path.join(here, "..", "agent", "worktree-setup");
  const runs = worktrees.map(
    (worktree) =>
      new Promise((resolve) => {
        const child = spawn(cli, [worktree, "--cache", path.join(dir, "cache")], { env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      }),
  );
  const results = await Promise.all(runs);
  for (const { code, out } of results) assert.equal(code, 0, out);
  assert.equal(fs.readFileSync(path.join(dir, "installs"), "utf8").trim().split("\n").length, 1);
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split("\n");
  for (const n of [0, 1, 2]) assert.equal(exclude.filter((line) => line === `/w${n}/${GUARD_FILE}`).length, 1);
  for (const worktree of worktrees) assert.ok(fs.existsSync(path.join(worktree, "node_modules", "x", "index.js")));
});

test("pnpm install fails loudly in a linked worktree and leaves its links alone", { skip: spawnSync("pnpm", ["--version"]).status !== 0 && "pnpm isn't installed" }, () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const result = setup(worktree);
  fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"ardia","private":true,"dependencies":{"react":"19.1.4"}}');
  fs.rmSync(path.join(worktree, "pnpm-lock.yaml"));
  const before = snapshot(path.join(worktree, "node_modules"));
  const treeBefore = snapshot(result.sourceRoot);
  const run = spawnSync("pnpm", ["install", "--offline"], { cwd: worktree, encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /pnpm install is\s+blocked here/);
  assert.equal(snapshot(path.join(worktree, "node_modules")), before);
  assert.equal(snapshot(result.sourceRoot), treeBefore);
});

test("CR1: an unsupported workspace pattern fails setup instead of matching nothing", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "pnpm-workspace.yaml"), "packages:\n  - packages/**\n");
  assert.throws(() => setup(worktree), /unsupported workspace pattern "packages\/\*\*"/);
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules")));
});

test("CR2: a workspace project outside the worktree fails setup before anything is read or written", () => {
  const { setup } = harness();
  const parent = fresh("parent");
  const worktree = path.join(parent, "wt");
  fs.cpSync(makeWorktree(), worktree, { recursive: true });
  write(path.join(parent, "sibling", "package.json"), "{}");
  write(path.join(worktree, "pnpm-workspace.yaml"), "packages:\n  - ../sibling\n");
  assert.throws(() => setup(worktree), /leaves the worktree/);
  write(path.join(worktree, "pnpm-workspace.yaml"), "packages:\n  - escape\n");
  fs.symlinkSync(path.join(parent, "sibling"), path.join(worktree, "escape"));
  assert.throws(() => setup(worktree), /leaves the worktree/);
});

test("CR3: undo refuses a marker whose inventory leaves the worktree, before changing anything", () => {
  const { setup } = harness();
  const parent = fresh("parent");
  const worktree = path.join(parent, "wt");
  fs.cpSync(makeWorktree(), worktree, { recursive: true });
  setup(worktree);
  const victim = path.join(parent, "victim", "node_modules", "keep.js");
  write(victim, "x");
  const markerFile = path.join(worktree, "node_modules", MARKER);
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  fs.writeFileSync(markerFile, JSON.stringify({ ...marker, projects: [...marker.projects, "../victim"] }));
  assert.throws(() => undoWorktree(worktree, { log: quiet }), /leaves the worktree/);
  assert.ok(fs.existsSync(victim));
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "react")), "nothing was removed");
});

test("CR4: re-setup needs --replace before it removes a newly managed project's own install", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(worktree);
  write(path.join(worktree, "packages", "kit", "node_modules", "own", "index.js"), "mine");
  write(path.join(worktree, "packages", "kit", "package.json"), '{"name":"@ardia/kit","dependencies":{"left-pad":"1"}}');
  const install = (staging) => {
    fakeInstall(staging);
    write(path.join(staging, "packages", "kit", "node_modules", "left-pad", "index.js"), "x");
  };
  const build = ({ worktree: from, cacheRoot, runtime }) => buildCache({ worktree: from, cacheRoot, runtime, install });
  assert.throws(() => setup(worktree, { build }), /packages\/kit\/node_modules is its own install; pass --replace/);
  assert.equal(fs.readFileSync(path.join(worktree, "packages", "kit", "node_modules", "own", "index.js"), "utf8"), "mine");
  setup(worktree, { build, replace: true });
  assert.ok(fs.lstatSync(path.join(worktree, "packages", "kit", "node_modules", "left-pad")).isSymbolicLink());
});

test("CR5: a failed cleanup during re-setup keeps the old marker, so undo still works", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(worktree);
  write(path.join(worktree, "packages", "base", "package.json"), '{"name":"@ardia/base","version":"2"}');
  const realRm = fs.rmSync;
  t.mock.method(fs, "rmSync", (file, ...rest) => {
    if (String(file).includes(`${path.sep}apps${path.sep}web${path.sep}node_modules${path.sep}`)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return realRm(file, ...rest);
  });
  assert.throws(() => setup(worktree), /busy/);
  t.mock.restoreAll();
  assert.ok(markerState(worktree).key, "the old marker is still there");
  undoWorktree(worktree, { log: quiet });
  assert.ok(!fs.existsSync(path.join(worktree, "apps", "web", "node_modules")));
});

test("CR6: a pnpmfile symlink, dangling or not, is refused and never written through", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const target = path.join(fresh("outside"), "pnpmfile.cjs");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(target, path.join(worktree, GUARD_FILE));
  assert.throws(() => setup(worktree), /isn't a regular file/);
  assert.ok(!fs.existsSync(target));
  fs.writeFileSync(target, GUARD_SOURCE);
  assert.throws(() => setup(worktree), /isn't a regular file/);
});

test("CR7: the staged .npmrc is private while installing and gone from the published cache", () => {
  const { cacheRoot } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, ".npmrc"), "//registry.example/:_authToken=secret\n");
  let mode = null;
  const result = setupWorktree(worktree, {
    cacheRoot,
    runtime: RUNTIME,
    log: quiet,
    home: fresh("home"),
    build: ({ worktree: from, cacheRoot: cache, runtime }) =>
      buildCache({ worktree: from, cacheRoot: cache, runtime, install: (staging) => {
        mode = fs.statSync(path.join(staging, ".npmrc")).mode & 0o777;
        fakeInstall(staging);
      } }),
  });
  assert.equal(mode, 0o600);
  assert.ok(!fs.existsSync(path.join(result.sourceRoot, ".npmrc")));
});

test("CR10: --status reports a missing or changed dependency link", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(worktree);
  assert.deepEqual(worktreeStatus(worktree, { runtime: RUNTIME }).problems, []);
  fs.rmSync(path.join(worktree, "node_modules", "react"));
  fs.rmSync(path.join(worktree, "node_modules", "@babel"));
  fs.symlinkSync("/elsewhere", path.join(worktree, "node_modules", "@babel"));
  const problems = worktreeStatus(worktree, { runtime: RUNTIME }).problems.join("\n");
  assert.match(problems, /node_modules\/react is missing/);
  assert.match(problems, /node_modules\/@babel points at \/elsewhere/);
});

test("CR12: setup drops .metadata_never_index into the given home, not the real one", () => {
  const { setup } = harness();
  const home = fresh("home");
  fs.mkdirSync(path.join(home, "ardia-scratch"), { recursive: true });
  setup(makeWorktree(), { home });
  assert.ok(fs.existsSync(path.join(home, "ardia-scratch", ".metadata_never_index")));
});

test("CR14: exclude rules are written relative to the git top level, so they hide a subfolder export's files", () => {
  const { setup } = harness();
  const repo = gitRepo(fresh("repo"));
  const exported = path.join(repo, "exports", "w0");
  fs.cpSync(makeWorktree(), exported, { recursive: true });
  setup(exported);
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split("\n");
  assert.ok(exclude.includes(`/exports/w0/${GUARD_FILE}`), exclude.join("|"));
  assert.equal(gitIn(repo, "check-ignore", "-q", `exports/w0/${GUARD_FILE}`).status, 0);
  assert.equal(gitIn(repo, "check-ignore", "-q", "exports/w0/.metadata_never_index").status, 0);
});

test("CR15: --replace keeps the own install if the cache vanishes before the locked check", () => {
  const { cacheRoot, setup } = harness();
  setup(makeWorktree());
  const worktree = makeWorktree();
  write(path.join(worktree, "node_modules", "real-install", "index.js"), "mine");
  const realRealpath = fs.realpathSync;
  let pruned = false;
  const { key } = { key: dependencyKey(installInputs(worktree, RUNTIME)) };
  const stamp = path.join(cacheRoot, key, CACHE_STAMP);
  const realExists = fs.existsSync;
  let checks = 0;
  const restore = () => {
    fs.existsSync = realExists;
    fs.realpathSync = realRealpath;
  };
  fs.existsSync = (file) => {
    if (file === stamp && ++checks === 3 && !pruned) {
      pruned = true;
      removeTree(path.join(cacheRoot, key));
    }
    return realExists(file);
  };
  try {
    assert.throws(() => setup(worktree, { replace: true }), /isn't built \(or was just pruned\)/);
  } finally {
    restore();
  }
  assert.ok(pruned);
  assert.equal(fs.readFileSync(path.join(worktree, "node_modules", "real-install", "index.js"), "utf8"), "mine");
});

test("CR16: cleanup uses the inventory read under the registry lock, not the one read before the build", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(worktree);
  write(path.join(worktree, "patches", "left-pad@1.0.0.patch"), "patch v2\n");
  const build = ({ worktree: from, cacheRoot, runtime }) => {
    const markerFile = path.join(from, "node_modules", MARKER);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    fs.writeFileSync(markerFile, JSON.stringify({ ...marker, projects: [...marker.projects, "packages/kit"] }));
    fs.mkdirSync(path.join(from, "packages", "kit", "node_modules"), { recursive: true });
    fs.symlinkSync("/gone", path.join(from, "packages", "kit", "node_modules", "stale-link"));
    return buildCache({ worktree: from, cacheRoot, runtime, install: fakeInstall });
  };
  setup(worktree, { build });
  assert.equal(lstatOrNullForTest(path.join(worktree, "packages", "kit", "node_modules", "stale-link")), null, "the concurrently managed folder was cleaned");
});

test("CR17: undo releases the claim before removing anything, so a lock failure leaves it retryable", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  setup(worktree);
  const lockFile = path.join(cacheRoot, ".registry.lock");
  fs.rmSync(lockFile, { force: true });
  fs.mkdirSync(lockFile);
  assert.throws(() => undoWorktree(worktree, { log: quiet }), /cannot open|can't take/);
  assert.ok(markerState(worktree).key, "the marker is still there");
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "react")));
  fs.rmdirSync(lockFile);
  undoWorktree(worktree, { log: quiet });
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules")));
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, USERS_DIR)), []);
});

test("CR18: an age that isn't a finite, non-negative number is refused before prune scans", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const { key } = setup(worktree);
  undoWorktree(worktree, { log: quiet });
  for (const age of [NaN, -1, Infinity]) assert.throws(() => pruneCaches({ cacheRoot, olderThanDays: age, log: quiet }), /--older-than/);
  assert.throws(() => parseArgs(["--prune", "--older-than", "typo"]), /--older-than/);
  assert.equal(parseArgs(["--prune", "--older-than", "0"]).olderThanDays, 0);
  assert.ok(fs.existsSync(path.join(cacheRoot, key, CACHE_STAMP)));
  assert.deepEqual(pruneCaches({ cacheRoot, olderThanDays: 0, now: Date.now() + 1000, log: quiet }), [path.join(cacheRoot, key)]);
});

test("a cache hit removes a stray .npmrc left by a build from before it was dropped", () => {
  const { setup } = harness();
  const { sourceRoot } = setup(makeWorktree());
  fs.writeFileSync(path.join(sourceRoot, ".npmrc"), "//registry.example/:_authToken=old\n", { mode: 0o644 });
  setup(makeWorktree());
  assert.ok(!fs.existsSync(path.join(sourceRoot, ".npmrc")));
});

test("an unreadable .pnpmfile.cjs fails setup instead of being replaced", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const file = path.join(worktree, GUARD_FILE);
  fs.writeFileSync(file, "module.exports = { hooks: {} };\n");
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => setup(worktree), /can't read .*\.pnpmfile\.cjs/);
  } finally {
    fs.chmodSync(file, 0o644);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "module.exports = { hooks: {} };\n");
});

test("CR20: a corrupt or invalid marker stops setup and undo before anything is deleted", () => {
  const { setup } = harness();
  for (const bad of ["{ not json", "{}", '{"key":"0123456789abcdef"}']) {
    const worktree = makeWorktree();
    setup(worktree);
    fs.writeFileSync(path.join(worktree, "node_modules", MARKER), bad);
    const before = snapshot(path.join(worktree, "node_modules"));
    assert.throws(() => setup(worktree, { replace: true }), /marker .* (is corrupt|isn't valid)/, bad);
    assert.throws(() => undoWorktree(worktree, { log: quiet }), /marker .* (is corrupt|isn't valid)/, bad);
    assert.equal(snapshot(path.join(worktree, "node_modules")), before, bad);
  }
});

test("CR21: an install input that exists but can't be read fails setup", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, ".npmrc"), "//registry.example/:_authToken=secret\n");
  fs.chmodSync(path.join(worktree, ".npmrc"), 0o000);
  try {
    assert.throws(() => setup(worktree), /can't read .*\.npmrc/);
  } finally {
    fs.chmodSync(path.join(worktree, ".npmrc"), 0o600);
  }
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules")));
});

test("CR22: the pnpm guard is in place before the first dependency link appears", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const realSymlink = fs.symlinkSync;
  let guarded = null;
  t.mock.method(fs, "symlinkSync", (target, file) => {
    if (guarded === null && String(file).startsWith(worktree)) guarded = fs.existsSync(path.join(worktree, GUARD_FILE));
    return realSymlink(target, file);
  });
  setup(worktree);
  t.mock.restoreAll();
  assert.equal(guarded, true);
});

test("CR23: --build-cache refuses to run outside scripts/agent/locked pod", () => {
  const worktree = makeWorktree();
  const env = { ...process.env, HOME: fresh("home") };
  delete env.AC_LOCKED_HELD;
  const run = spawnSync(process.execPath, [path.join(here, "worktree-deps.mjs"), "--build-cache", worktree, "--cache", fresh("cache")], { encoding: "utf8", env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--build-cache runs only under scripts\/agent\/locked pod/);
});

test("CR24/CR25: workspace forms setup can't read fail loudly instead of matching nothing", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "pnpm-workspace.yaml"), "packages: [apps/*, packages/*]\n");
  assert.throws(() => setup(worktree), /inline packages list/);
  write(path.join(worktree, "pnpm-workspace.yaml"), 'packages:\n  - apps/*\n  - "!apps/*"\n');
  assert.throws(() => setup(worktree), /unsupported workspace pattern "!apps\/\*"/);
});

test("CR27: prune deletes only folders it can prove are its own caches", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const { key } = setup(worktree);
  undoWorktree(worktree, { log: quiet });
  write(path.join(cacheRoot, "reports", CACHE_STAMP), "{}");
  write(path.join(cacheRoot, "fedcba9876543210", CACHE_STAMP), JSON.stringify({ key: "0123456789abcdef" }));
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const name of ["reports", "fedcba9876543210"]) fs.utimesSync(path.join(cacheRoot, name, CACHE_STAMP), old, old);
  assert.deepEqual(pruneCaches({ cacheRoot, now: LATER(), log: quiet }), [path.join(cacheRoot, key)]);
  assert.ok(fs.existsSync(path.join(cacheRoot, "reports", CACHE_STAMP)));
  assert.ok(fs.existsSync(path.join(cacheRoot, "fedcba9876543210", CACHE_STAMP)));
});

test("CR28: a marker with an unsupported version or state stops setup and undo", () => {
  const { setup } = harness();
  for (const change of [{ version: 99 }, { state: "done" }, { version: undefined }]) {
    const worktree = makeWorktree();
    setup(worktree);
    const markerFile = path.join(worktree, "node_modules", MARKER);
    fs.writeFileSync(markerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(markerFile, "utf8")), ...change }));
    const before = snapshot(path.join(worktree, "node_modules"));
    assert.deepEqual(markerState(worktree), { unknown: true }, JSON.stringify(change));
    assert.throws(() => undoWorktree(worktree, { log: quiet }), /is corrupt or isn't valid/);
    assert.throws(() => setup(worktree, { replace: true }), /is corrupt or isn't valid/);
    assert.equal(snapshot(path.join(worktree, "node_modules")), before);
  }
});

test("CR29: an unreadable workspace folder fails setup instead of dropping its manifests", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  fs.chmodSync(path.join(worktree, "packages"), 0o000);
  try {
    assert.throws(() => setup(worktree), /can't read .*packages/);
  } finally {
    fs.chmodSync(path.join(worktree, "packages"), 0o755);
  }
});

test("CR30: a first setup that fails after publishing the guard says how to recover", () => {
  const { cacheRoot, setup } = harness();
  setup(makeWorktree());
  const worktree = makeWorktree();
  const lockFile = path.join(cacheRoot, ".registry.lock");
  fs.rmSync(lockFile, { force: true });
  fs.mkdirSync(lockFile);
  try {
    assert.throws(() => setup(worktree), /delete .*\.pnpmfile\.cjs by hand/);
  } finally {
    fs.rmdirSync(lockFile);
  }
});
