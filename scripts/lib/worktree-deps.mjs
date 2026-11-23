import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = ".ardia-linked-deps.json";
export const GUARD_FILE = ".pnpmfile.cjs";
const NEVER_INDEX = ".metadata_never_index";
export const CACHE_STAMP = "deps.json";
export const USERS_DIR = ".users";
const LINKED_DOT_ENTRIES = new Set([".bin"]);
const WORKSPACE_SCOPE = "@ardia";
const MARKER_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const self = fileURLToPath(import.meta.url);
const lockedScript = path.join(path.dirname(self), "..", "agent", "locked");

export const HELP = `worktree-setup: give a worktree or scratch export working node_modules in seconds, as links into one shared,
read-only dependency tree instead of an APFS clone (a clone writes 100k+ inodes and keeps fseventsd busy).

  scripts/agent/worktree-setup <worktree> [--cache <dir>] [--replace]
  scripts/agent/worktree-setup --status <worktree>
  scripts/agent/worktree-setup --undo <worktree>
  scripts/agent/worktree-setup --prune [--older-than <days>] [--cache <dir>]
  scripts/agent/worktree-setup -h | --help

What it does to <worktree>:
  - node_modules (the root and every pnpm workspace project's) becomes a real folder of per-entry links into the
    dependency tree. @ardia/* links point at the worktree's own apps/* and packages/*.
    Dot entries other than .bin stay local, so caches (.cache, .vite) land in the worktree.
  - The dependency tree is a pnpm install made once per set of install inputs (the lockfile, .npmrc,
    pnpm-workspace.yaml, every workspace package.json, patches/, and the platform, CPU and Node major version)
    under the cache (default ~/ardia-scratch/deps.noindex/<key>, $ARDIA_DEPS_CACHE moves it). It is built, checked,
    made read-only and published under scripts/agent/locked pod; every later worktree with the same inputs reuses it
    in milliseconds. Read-only matters: pnpm with its guard skipped writes through per-entry links, and so can npm
    or a build script; the read-only tree refuses them all.
  - .pnpmfile.cjs blocks pnpm install there (pnpm run and pnpm exec print the block, then still run the script).
    Run tools with node or node_modules/.bin. It and .metadata_never_index go into the repo's info/exclude.
    Setup refuses a worktree that already has its own .pnpmfile.cjs.
  - node_modules/${MARKER} lists every folder setup manages, written before the first link. apps/browser/metro.config.js
    reads it to watch and resolve through the links, so Metro, js-bench.mjs bundle and the Xcode bundle phase work
    unchanged. The cache's ${USERS_DIR}/ records each linked worktree (a git worktree by its git dir, which survives
    git worktree move; anything else by its path) and the caches it claims. Setup holds one kernel lock
    (<cache>/.registry.lock, freed when its holder dies) from its claim until the marker names the new cache, and
    --prune holds it throughout; a build takes the pod lock first and never the other way round.
  - .metadata_never_index goes into the worktree, the cache and ~/ardia-scratch and ~/ardia-wt when they exist.

--status   says which tree the worktree uses and whether it still matches its install inputs.
--undo     removes the links, the guard, the marker and the worktree's record; the dependency tree is left alone.
--prune    deletes a cached tree unused for --older-than days (default 7) only when every claim on it is provably
           dead: a git worktree's claims last while its git dir exists (moves, submodules and separate git dirs
           included); anything else's while its path holds a marker naming the tree. An unreadable marker keeps the
           tree, an unreadable record stops the prune. A scratch export that moved must run setup again.
--replace  lets setup replace a worktree's own node_modules (a real install or a whole-folder link), e.g. to link
           again after --undo and a real pnpm install.
`;

export function normalizeLockfile(text) {
  const documents = text
    .split(/^---[ \t]*$/m)
    .map((document) => document.replace(/^\r?\n/, ""))
    .filter((document) => document.trim());
  return documents.at(-1) ?? "";
}

export function runtimeOf(process_ = process) {
  return `${process_.platform}-${process_.arch}-node${process_.versions.node.split(".")[0]}`;
}

export function dependencyKey({ files, runtime }) {
  const hash = createHash("sha256");
  hash.update(`runtime\0${runtime}`);
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, content] of sorted) hash.update(`\0file\0${name}\0${content.length}\0`).update(content);
  return hash.digest("hex").slice(0, 16);
}

export function workspacePatterns(workspaceYaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    const inline = /^packages:\s*(\S.*?)\s*$/.exec(line);
    if (inline && inline[1] !== "[]") throw new Error(`pnpm-workspace.yaml has an inline packages list (${inline[1]}); worktree-setup reads one "- pattern" per line`);
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item) {
      patterns.push(item[1].replace(/^(['"])(.*)\1$/, "$2"));
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) inPackages = false;
  }
  return patterns;
}

function insideReal(realRoot, target) {
  let current = target;
  while (!lstatOrNull(current)) current = path.dirname(current);
  try {
    const relative = path.relative(realRoot, fs.realpathSync(current));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function checkedProject(root, project) {
  if (typeof project !== "string") throw new Error(`workspace project ${JSON.stringify(project)} isn't a path`);
  const resolved = path.resolve(root, project);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !insideReal(fs.realpathSync(root), resolved)) {
    throw new Error(`workspace project "${project}" leaves the worktree ${root}`);
  }
  return relative.split(path.sep).join("/");
}

export function workspaceProjects(root, workspaceYaml) {
  const patterns = workspacePatterns(workspaceYaml);
  const baseOf = (pattern) => {
    if (pattern.startsWith("!") && pattern.includes("*")) throw new Error(`unsupported workspace pattern "${pattern}" in pnpm-workspace.yaml; exclusions must be literal paths`);
    const plain = pattern.replace(/^!/, "").replace(/\/$/, "");
    const base = plain.endsWith("/*") ? plain.slice(0, -2) : plain;
    if (/[*?[\]{}]/.test(base)) throw new Error(`unsupported workspace pattern "${pattern}" in pnpm-workspace.yaml; worktree-setup takes literal paths and dir/*`);
    return { base, children: plain.endsWith("/*") };
  };
  const excluded = new Set(patterns.filter((p) => p.startsWith("!")).map((p) => checkedProject(root, baseOf(p).base)));
  const projects = new Set([""]);
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const { base, children } = baseOf(pattern);
    checkedProject(root, base);
    const candidates = children ? listDirs(path.join(root, base)).map((name) => `${base}/${name}`) : [base];
    for (const candidate of candidates) {
      const project = checkedProject(root, candidate);
      if (!excluded.has(project) && fs.existsSync(path.join(root, project, "package.json"))) projects.add(project);
    }
  }
  return [...projects].sort();
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw new Error(`can't read ${dir} (${error.code}); fix its permissions or move it away`);
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw new Error(`can't read ${file} (${error.code}); fix its permissions or move it away`);
  }
}

export function installInputs(root, runtime = runtimeOf()) {
  const lockfile = readBytes(path.join(root, "pnpm-lock.yaml"));
  if (lockfile === null) throw new Error(`${root} has no pnpm-lock.yaml`);
  const workspace = readBytes(path.join(root, "pnpm-workspace.yaml"));
  const projects = workspaceProjects(root, workspace?.toString("utf8") ?? "");
  const snapshot = new Map([["pnpm-lock.yaml", lockfile], ["pnpm-workspace.yaml", workspace]]);
  const names = [".npmrc", ...projects.map((p) => (p ? `${p}/package.json` : "package.json"))];
  let patches = [];
  try {
    patches = fs.readdirSync(path.join(root, "patches"), { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new Error(`can't read ${path.join(root, "patches")} (${error.code})`);
  }
  for (const entry of patches) if (entry.isFile()) names.push(`patches/${entry.name}`);
  for (const name of names) snapshot.set(name, readBytes(path.join(root, name)));
  const files = [...snapshot].filter(([, content]) => content !== null);
  return { files, runtime, projects, lockfile: lockfile.toString("utf8") };
}

function readEntries(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.name === WORKSPACE_SCOPE && entry.isDirectory()) {
        const links = fs
          .readdirSync(full, { withFileTypes: true })
          .filter((e) => e.isSymbolicLink())
          .map((e) => ({ name: e.name, link: fs.readlinkSync(path.join(full, e.name)) }));
        return { name: entry.name, kind: "workspace-scope", links };
      }
      return { name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file" };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function planLinks({ sourceRoot, worktreeRoot, project, entries, exists = fs.existsSync }) {
  const sourceDir = path.join(sourceRoot, project, "node_modules");
  const targetDir = path.join(worktreeRoot, project, "node_modules");
  const ops = [{ type: "mkdir", path: targetDir }];
  const warnings = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !LINKED_DOT_ENTRIES.has(entry.name)) continue;
    if (entry.kind === "workspace-scope") {
      const scopeDir = path.join(targetDir, entry.name);
      ops.push({ type: "mkdir", path: scopeDir });
      for (const { name, link } of entry.links) {
        const resolved = path.resolve(sourceDir, entry.name, link);
        const relative = path.relative(sourceRoot, resolved);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          warnings.push(`${entry.name}/${name} in ${sourceDir} points outside its tree (${link}); not linked`);
          continue;
        }
        const own = path.join(worktreeRoot, relative);
        if (!exists(own)) {
          warnings.push(`${entry.name}/${name}: the worktree has no ${relative}; not linked`);
          continue;
        }
        ops.push({ type: "symlink", path: path.join(scopeDir, name), target: path.relative(scopeDir, own) });
      }
      continue;
    }
    ops.push({ type: "symlink", path: path.join(targetDir, entry.name), target: path.join(sourceDir, entry.name) });
  }
  return { ops, warnings };
}

function markerOf(worktree) {
  const state = markerState(worktree);
  if (state.absent) return null;
  const file = path.join(worktree, "node_modules", MARKER);
  if (state.unknown) throw new Error(`the marker ${file} is corrupt or isn't valid; fix or remove it (and its links) by hand`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(partial, file);
}

function ownInstallDirs(worktree, projects, replace) {
  const dirs = projects.map((project) => path.join(worktree, project, "node_modules")).filter((dir) => lstatOrNull(dir));
  if (dirs.length && !replace) {
    const what = lstatOrNull(dirs[0]).isSymbolicLink() ? "is a link to a whole node_modules" : "is its own install";
    throw new Error(`${dirs[0]} ${what}; pass --replace to swap it for per-entry links`);
  }
  return dirs;
}

function prepareTarget(worktree, projects, previous) {
  for (const project of previous?.projects ?? []) {
    const dir = path.join(worktree, project, "node_modules");
    if (!lstatOrNull(dir)) continue;
    if (lstatOrNull(dir).isSymbolicLink() || !projects.includes(project)) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.name.startsWith(".") || LINKED_DOT_ENTRIES.has(entry.name)) {
        fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function applyOps(ops) {
  let links = 0;
  for (const op of ops) {
    if (op.type === "mkdir") fs.mkdirSync(op.path, { recursive: true });
    else {
      fs.symlinkSync(op.target, op.path);
      links++;
    }
  }
  return links;
}

const GUARD_SIGNATURE = "pnpm install is blocked in a worktree linked by scripts/agent/worktree-setup";

export const GUARD_SOURCE = `const message = [
  "",
  "worktree-setup: this worktree's node_modules are links into a shared dependency tree, so pnpm install is",
  "blocked here: it would rewrite that tree under every worktree that uses it.",
  "Run tools with node or node_modules/.bin. pnpm run and pnpm exec still run their script after this message.",
  "To install for real: scripts/agent/worktree-setup --undo <this worktree>, then pnpm install under scripts/agent/locked pod.",
  "",
].join("\\n");
let told = false;
function blocked() {
  if (!told) process.stderr.write(message);
  told = true;
  throw new Error("${GUARD_SIGNATURE}");
}
module.exports = { hooks: { preResolution: blocked, readPackage: blocked } };
`;

function isOurGuard(text) {
  return text !== null && text.includes(`throw new Error("${GUARD_SIGNATURE}")`);
}

function checkGuardSlot(worktree) {
  const tracked = spawnSync("git", ["-C", worktree, "ls-files", "--error-unmatch", GUARD_FILE], { stdio: "ignore" }).status === 0;
  if (tracked) throw new Error(`${worktree} tracks its own ${GUARD_FILE}, so its pnpm install can't be blocked; link it by hand or not at all`);
  const file = path.join(worktree, GUARD_FILE);
  const stat = lstatOrNull(file);
  if (stat && !stat.isFile()) throw new Error(`${file} isn't a regular file; move it away first`);
  let existing = null;
  if (stat) {
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`can't read ${file} (${error.code}); move it away first`);
    }
  }
  if (existing !== null && !isOurGuard(existing)) {
    throw new Error(`${file} is someone else's pnpmfile; move it away first (setup would replace it and --undo would delete it)`);
  }
}

const HOLD_LOCK_PERL = `
use Fcntl qw(:flock);
my ($lock, $ready, $wait) = @ARGV;
my $in = "";
vec($in, fileno(STDIN), 1) = 1;
sub parent_gone {
  my $readable = $in;
  return 0 unless select($readable, undef, undef, $_[0]) > 0;
  my $buf;
  return sysread(STDIN, $buf, 64) ? 0 : 1;
}
open(my $fh, ">>", $lock) or do { open(my $f, ">", "$ready.failed"); print $f "cannot open $lock: $!"; close $f; exit 74 };
my $deadline = time + $wait;
until (flock($fh, LOCK_EX | LOCK_NB)) {
  if (time >= $deadline) { open(my $f, ">", "$ready.timeout"); close $f; exit 75; }
  exit 0 if parent_gone(0.05);
}
open(my $r, ">", $ready) or die;
close $r;
until (parent_gone(undef)) {}
unlink $ready;
`;

export function withKernelLock(lockFile, action, { waitSeconds = 300 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const ready = path.join(os.tmpdir(), `worktree-setup-lock-${process.pid}-${createHash("sha256").update(`${lockFile}${Date.now()}${Math.random()}`).digest("hex").slice(0, 12)}`);
  const holder = spawn("perl", ["-e", HOLD_LOCK_PERL, lockFile, ready, String(waitSeconds)], { stdio: ["pipe", "ignore", "inherit"] });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + (waitSeconds + 5) * 1000;
  try {
    while (!fs.existsSync(ready)) {
      if (fs.existsSync(`${ready}.failed`)) throw new Error(`can't take ${lockFile}: ${readIfExists(`${ready}.failed`)}`);
      if (fs.existsSync(`${ready}.timeout`) || Date.now() > deadline) throw new Error(`${lockFile} is still held after ${waitSeconds} s`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
    return action();
  } finally {
    holder.kill("SIGKILL");
    fs.rmSync(ready, { force: true });
    fs.rmSync(`${ready}.timeout`, { force: true });
    fs.rmSync(`${ready}.failed`, { force: true });
  }
}

function excludeFromGit(worktree, names) {
  const result = spawnSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const file = path.resolve(worktree, gitLine(result.stdout));
  const top = spawnSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const relative = path.relative(fs.realpathSync(gitLine(top.stdout)), worktree).split(path.sep).join("/");
  const escape = (text) => text.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ");
  const rules = names.map((name) => `/${relative ? `${escape(relative)}/` : ""}${escape(name)}`);
  withKernelLock(path.join(path.dirname(file), "exclude.worktree-setup.lock"), () => {
    const current = readIfExists(file) ?? "";
    const lines = new Set(current.split(/\r?\n/));
    const missing = rules.filter((line) => !lines.has(line));
    if (missing.length) fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  });
  return file;
}

function dropNeverIndex(dir) {
  const file = path.join(dir, NEVER_INDEX);
  if (fs.existsSync(dir) && !fs.existsSync(file)) {
    fs.writeFileSync(file, "");
    return true;
  }
  return false;
}

function defaultCacheRoot() {
  return path.resolve(process.env.ARDIA_DEPS_CACHE || path.join(os.homedir(), "ardia-scratch", "deps.noindex"));
}


function pnpmInstall(staging) {
  const log = path.join(staging, "install.log");
  const out = fs.openSync(log, "w");
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone-or-copy", "--reporter=append-only"], { cwd: staging, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  if (result.status !== 0) {
    const tail = (readIfExists(log) ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`pnpm install for the dependency cache failed (exit ${result.status ?? result.error?.code}); the end of ${log}:\n${tail}`);
  }
}

function stageInputs(staging, files) {
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
    fs.writeFileSync(path.join(staging, name), content, { mode: name === ".npmrc" ? 0o600 : 0o644, flag: "wx" });
  }
}

function setWritable(dirs, writable) {
  if (dirs.length === 0) return;
  execFileSync("chmod", ["-R", writable ? "u+w" : "a-w", ...dirs]);
}

export function removeTree(dir) {
  if (!lstatOrNull(dir)) return;
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function buildCache({ worktree, cacheRoot, install = pnpmInstall, runtime = runtimeOf() }) {
  const inputs = installInputs(worktree, runtime);
  const key = dependencyKey(inputs);
  const final = path.join(cacheRoot, key);
  if (fs.existsSync(path.join(final, CACHE_STAMP))) return { dir: final, key, created: false };
  fs.mkdirSync(cacheRoot, { recursive: true });
  dropNeverIndex(cacheRoot);
  for (const name of fs.readdirSync(cacheRoot)) if (name.startsWith(".staging-")) removeTree(path.join(cacheRoot, name));
  const staging = path.join(cacheRoot, `.staging-${key}-${process.pid}`);
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  try {
    stageInputs(staging, inputs.files);
    install(staging);
    fs.rmSync(path.join(staging, ".npmrc"), { force: true });
    const installed = readIfExists(path.join(staging, "node_modules", ".pnpm", "lock.yaml"));
    if (installed === null || normalizeLockfile(installed) !== normalizeLockfile(inputs.lockfile)) throw new Error("the cache install's lockfile doesn't match the worktree's");
    setWritable(inputs.projects.map((project) => path.join(staging, project, "node_modules")).filter((dir) => fs.existsSync(dir)), false);
    const fingerprint = { key, runtime, files: Object.fromEntries(inputs.files.map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])) };
    writeJsonAtomic(path.join(staging, CACHE_STAMP), { ...fingerprint, created: new Date().toISOString(), from: worktree });
    removeTree(final);
    fs.renameSync(staging, final);
    return { dir: final, key, created: true };
  } catch (error) {
    removeTree(staging);
    throw error;
  }
}

function underPodLock(args) {
  const result = spawnSync(lockedScript, ["pod", "--wait", "500", "--", process.execPath, self, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${args[0]} under scripts/agent/locked pod failed (exit ${result.status ?? result.error?.code})`);
}

const registryLock = (cacheRoot) => path.join(cacheRoot, ".registry.lock");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export const gitLine = (output) => (output.endsWith("\n") ? output.slice(0, -1) : output);

export function identityOf(worktree) {
  const git = (...args) => spawnSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", ...args], { encoding: "utf8" });
  const top = git("--show-toplevel");
  const gitDir = git("--git-dir");
  if (top.status === 0 && gitDir.status === 0 && fs.realpathSync(gitLine(top.stdout)) === worktree) return { id: `git:${gitLine(gitDir.stdout)}`, gitDir: gitLine(gitDir.stdout) };
  return { id: `path:${worktree}`, gitDir: null };
}

const recordFile = (cacheRoot, identity) => path.join(cacheRoot, USERS_DIR, `${createHash("sha256").update(identity.id).digest("hex").slice(0, 16)}.json`);

function writeClaim(cacheRoot, worktree, identity, keys) {
  const file = recordFile(cacheRoot, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { id: identity.id, gitDir: identity.gitDir, worktree, keys, at: new Date().toISOString() });
  return file;
}

function planAll(worktree, sourceRoot, projects) {
  const plans = [];
  for (const project of projects) {
    const sourceDir = path.join(sourceRoot, project, "node_modules");
    if (fs.existsSync(sourceDir)) plans.push({ project, sourceDir, ...planLinks({ sourceRoot, worktreeRoot: worktree, project, entries: readEntries(sourceDir) }) });
  }
  return plans;
}

function linkInto(worktree, sourceRoot, key, projects, plans, previous) {
  prepareTarget(worktree, projects, previous);
  const rootModules = path.join(worktree, "node_modules");
  fs.mkdirSync(rootModules, { recursive: true });
  const markerFile = path.join(rootModules, MARKER);
  const managed = [...new Set([...plans.map((p) => p.project), ...(previous?.projects ?? [])])].sort();
  const marker = { version: MARKER_VERSION, key, root: sourceRoot, nodeModules: plans.map((p) => p.sourceDir), projects: managed, state: "linking", created: new Date().toISOString() };
  writeJsonAtomic(markerFile, marker);

  let links = 0;
  const warnings = [];
  for (const plan of plans) {
    links += applyOps(plan.ops);
    warnings.push(...plan.warnings);
  }
  marker.projects = plans.map((p) => p.project);
  marker.state = "linked";
  writeJsonAtomic(markerFile, marker);
  return { sourceRoot, marker, markerFile, links, warnings };
}

export function setupWorktree(worktreeArg, options = {}) {
  const started = Date.now();
  const log = options.log ?? console.log;
  const worktree = fs.realpathSync(worktreeArg);
  const cacheRoot = path.resolve(options.cacheRoot ?? defaultCacheRoot());
  const runtime = options.runtime ?? runtimeOf();
  checkGuardSlot(worktree);
  const inputs = installInputs(worktree, runtime);
  const key = dependencyKey(inputs);
  const previous = markerOf(worktree);
  const previouslyManaged = (previous?.projects ?? []).map((project) => checkedProject(worktree, project));
  ownInstallDirs(worktree, inputs.projects.filter((project) => !previouslyManaged.includes(project)), options.replace ?? false);

  fs.mkdirSync(cacheRoot, { recursive: true });
  dropNeverIndex(cacheRoot);
  const final = path.join(cacheRoot, key);
  let createdCache = false;
  if (!fs.existsSync(path.join(final, CACHE_STAMP))) {
    log(`installing ${key} into ${cacheRoot} (once per set of install inputs, under scripts/agent/locked pod)`);
    const build = options.build ?? (() => underPodLock(["--build-cache", worktree, "--cache", cacheRoot]));
    build({ worktree, cacheRoot, runtime });
    createdCache = true;
  }
  if (!fs.existsSync(path.join(final, CACHE_STAMP))) throw new Error(`building ${final} didn't publish ${CACHE_STAMP}`);
  fs.utimesSync(path.join(final, CACHE_STAMP), new Date(), new Date());
  const plans = planAll(worktree, fs.realpathSync(final), inputs.projects);
  const identity = identityOf(worktree);
  const guardPartial = path.join(worktree, `${GUARD_FILE}.${process.pid}.partial`);
  fs.writeFileSync(guardPartial, GUARD_SOURCE, { flag: "wx" });
  fs.renameSync(guardPartial, path.join(worktree, GUARD_FILE));
  const firstSetup = previous === null;
  const linkUnderLock = (action) => {
    try {
      return withKernelLock(registryLock(cacheRoot), action);
    } catch (error) {
      if (firstSetup && markerState(worktree).absent) error.message += `; to give up on this worktree, delete ${path.join(worktree, GUARD_FILE)} by hand`;
      throw error;
    }
  };
  const { record, sourceRoot, marker, markerFile, links, warnings } = linkUnderLock(() => {
    const stamp = path.join(final, CACHE_STAMP);
    if (!fs.existsSync(stamp)) throw new Error(`${final} isn't built (or was just pruned); run worktree-setup again`);
    fs.utimesSync(stamp, new Date(), new Date());
    fs.rmSync(path.join(final, ".npmrc"), { force: true });
    const current = markerOf(worktree);
    const managedNow = (current?.projects ?? []).map((project) => checkedProject(worktree, project));
    const ownNow = ownInstallDirs(worktree, inputs.projects.filter((project) => !managedNow.includes(project)), options.replace ?? false);
    for (const dir of ownNow) fs.rmSync(dir, { recursive: true, force: true });
    const claimed = readJson(recordFile(cacheRoot, identity))?.keys ?? [];
    const record = writeClaim(cacheRoot, worktree, identity, [...new Set([...claimed, ...(current?.key ? [current.key] : []), key])]);
    const linked = linkInto(worktree, fs.realpathSync(final), key, inputs.projects, plans, current);
    writeClaim(cacheRoot, worktree, identity, [key]);
    return { record, ...linked };
  });

  const home = options.home ?? os.homedir();
  const neverIndexed = [worktree, path.join(home, "ardia-scratch"), path.join(home, "ardia-wt")].filter(dropNeverIndex);
  const exclude = excludeFromGit(worktree, [GUARD_FILE, NEVER_INDEX]);

  const ms = Date.now() - started;
  log(`worktree-setup: ${worktree}`);
  log(`  dependencies: ${createdCache ? "a new cached install" : "the cached install"} ${sourceRoot} (key ${key})`);
  log(`  linked ${links} entries in ${marker.projects.length} node_modules folders (${marker.projects.map((p) => p || ".").join(", ")}) in ${ms} ms`);
  log(`  pnpm install is blocked by ${GUARD_FILE}; marker ${markerFile}; recorded in ${record}`);
  if (neverIndexed.length) log(`  added ${NEVER_INDEX} to ${neverIndexed.join(", ")}`);
  if (exclude) log(`  ${GUARD_FILE} and ${NEVER_INDEX} are listed in ${exclude}`);
  for (const warning of warnings) log(`  warning: ${warning}`);
  log(`  undo: scripts/agent/worktree-setup --undo ${worktree}`);
  return { worktree, key, sourceRoot, links, projects: marker.projects, warnings, ms, createdCache };
}

export function undoWorktree(worktreeArg, { log = console.log } = {}) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) throw new Error(`${worktree} isn't linked by worktree-setup (no node_modules/${MARKER})`);
  const projects = new Set(["", ...(Array.isArray(marker.projects) ? marker.projects : [])].map((project) => checkedProject(worktree, project)));
  if (marker.root) {
    const cacheRoot = path.dirname(marker.root);
    withKernelLock(registryLock(cacheRoot), () => fs.rmSync(recordFile(cacheRoot, identityOf(worktree)), { force: true }));
  }
  for (const project of [...projects].filter(Boolean).sort().reverse()) fs.rmSync(path.join(worktree, project, "node_modules"), { recursive: true, force: true });
  const guard = path.join(worktree, GUARD_FILE);
  if (lstatOrNull(guard)?.isFile() && isOurGuard(readIfExists(guard))) fs.rmSync(guard);
  fs.rmSync(path.join(worktree, "node_modules"), { recursive: true, force: true });
  log(`worktree-setup: removed the links in ${worktree} (${[...projects].map((p) => p || ".").join(", ")}) and its pnpm guard; ${marker.root} is untouched`);
}

export function worktreeStatus(worktreeArg, { runtime = runtimeOf() } = {}) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) return { linked: false, worktree, problems: [`no node_modules/${MARKER}`] };
  const problems = [];
  const key = dependencyKey(installInputs(worktree, runtime));
  if (key !== marker.key) problems.push(`the worktree's install inputs changed (key ${key}, linked ${marker.key}); run worktree-setup again`);
  if (!marker.root || !fs.existsSync(path.join(marker.root, CACHE_STAMP))) problems.push(`the cached install ${marker.root} is gone; run worktree-setup again`);
  if (marker.state !== "linked") problems.push("setup didn't finish; run worktree-setup again");
  if (readIfExists(path.join(worktree, GUARD_FILE)) !== GUARD_SOURCE) problems.push(`${GUARD_FILE} is missing or changed, so pnpm install isn't blocked`);
  if (marker.root && fs.existsSync(marker.root) && Array.isArray(marker.projects)) {
    for (const plan of planAll(worktree, marker.root, marker.projects.map((project) => checkedProject(worktree, project)))) {
      for (const op of plan.ops.filter((o) => o.type === "symlink")) {
        const name = path.relative(worktree, op.path);
        let actual = null;
        try {
          actual = fs.readlinkSync(op.path);
        } catch {}
        if (actual === null) problems.push(`${name} is missing (or isn't a link); run worktree-setup again`);
        else if (actual !== op.target) problems.push(`${name} points at ${actual}, not ${op.target}; run worktree-setup again`);
      }
    }
  }
  return { linked: true, worktree, marker, key, problems };
}

const missing = (file) => {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR";
  }
};

export function markerState(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "node_modules", MARKER), "utf8");
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? { absent: true } : { unknown: true };
  }
  let marker;
  try {
    marker = JSON.parse(text);
  } catch {
    return { unknown: true };
  }
  const valid =
    marker !== null &&
    typeof marker === "object" &&
    marker.version === MARKER_VERSION &&
    (marker.state === "linking" || marker.state === "linked") &&
    typeof marker.key === "string" &&
    /^[0-9a-f]{16}$/.test(marker.key) &&
    typeof marker.root === "string" &&
    path.isAbsolute(marker.root) &&
    path.basename(marker.root) === marker.key &&
    Array.isArray(marker.projects) &&
    Array.isArray(marker.nodeModules);
  return valid ? { key: marker.key } : { unknown: true };
}

export function liveKeys(cacheRoot) {
  const dir = path.join(cacheRoot, USERS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  const live = new Set();
  for (const name of names) {
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`can't read ${file} (${error.message}); pruned nothing`);
    }
    const claims = Array.isArray(record?.keys) ? record.keys : null;
    if (!claims) throw new Error(`${file} has no claims list; pruned nothing`);
    const keepAll = () => claims.forEach((key) => live.add(key));
    if (record.gitDir && !missing(record.gitDir)) {
      keepAll();
      continue;
    }
    const state = typeof record.worktree === "string" ? markerState(record.worktree) : { unknown: true };
    if (state.unknown) {
      keepAll();
      continue;
    }
    if (state.key && claims.includes(state.key)) {
      live.add(state.key);
      continue;
    }
    fs.rmSync(file, { force: true });
  }
  return live;
}

function checkedAge(days) {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) throw new Error(`--older-than takes a number of days, 0 or more (got ${days})`);
  return days;
}

export function pruneCaches({ cacheRoot = defaultCacheRoot(), olderThanDays = 7, now = Date.now(), log = console.log } = {}) {
  checkedAge(olderThanDays);
  const root = path.resolve(cacheRoot);
  if (!fs.existsSync(root)) return [];
  return withKernelLock(registryLock(root), () => {
    const live = liveKeys(root);
    const removed = [];
    for (const name of listDirs(root)) {
      if (!/^[0-9a-f]{16}$/.test(name) || live.has(name) || readJson(path.join(root, name, CACHE_STAMP))?.key !== name) continue;
      const dir = path.join(root, name);
      const stat = lstatOrNull(path.join(dir, CACHE_STAMP));
      if (!stat || now - stat.mtimeMs <= olderThanDays * DAY_MS) continue;
      removeTree(dir);
      removed.push(dir);
    }
    log(removed.length ? `worktree-setup: removed ${removed.join(", ")}` : `worktree-setup: nothing to prune in ${root}`);
    return removed;
  });
}

export function parseArgs(argv) {
  const options = { command: "setup", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "-h":
      case "--help":
        options.command = "help";
        break;
      case "--status":
        options.command = "status";
        break;
      case "--undo":
        options.command = "undo";
        break;
      case "--prune":
        options.command = "prune";
        break;
      case "--build-cache":
        options.command = "build-cache";
        break;
      case "--cache":
        options.cacheRoot = path.resolve(value());
        break;
      case "--older-than":
        options.olderThanDays = checkedAge(Number(value()));
        break;
      case "--replace":
        options.replace = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        options.positional.push(arg);
    }
  }
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === "prune") {
    pruneCaches({ cacheRoot, olderThanDays: options.olderThanDays ?? 7 });
    return 0;
  }
  const [worktree, ...rest] = options.positional;
  if (!worktree || rest.length) {
    process.stderr.write(HELP);
    return 64;
  }
  if (options.command === "build-cache") {
    if (!(process.env.AC_LOCKED_HELD ?? "").split("\n").some((line) => line.endsWith("/ac-pod.lockf"))) throw new Error("--build-cache runs only under scripts/agent/locked pod");
    buildCache({ worktree: fs.realpathSync(worktree), cacheRoot });
    return 0;
  }
  if (options.command === "undo") {
    undoWorktree(worktree);
    return 0;
  }
  if (options.command === "status") {
    const status = worktreeStatus(worktree);
    if (!status.linked) console.log(`worktree-setup: ${status.worktree} isn't linked`);
    else console.log(`worktree-setup: ${status.worktree} uses ${status.marker.root} (key ${status.marker.key})`);
    for (const problem of status.problems) console.log(`  ${problem}`);
    return status.linked && status.problems.length === 0 ? 0 : 1;
  }
  setupWorktree(worktree, { ...options, cacheRoot });
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === self) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`worktree-setup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
