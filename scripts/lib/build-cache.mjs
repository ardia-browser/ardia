import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const STAMP_VERSION = 6;

const NATIVE = [
  /^apps\/browser\/macos\//,
  /^apps\/browser\/(app\.json|react-native\.config\.js|package\.json)$/,
  /^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.npmrc|\.pnpmfile\.cjs)$/,
  /^patches\//,
  /^packages\/[^/]+\/ios\//,
  /^packages\/[^/]+\/(package\.json|expo-module\.config\.json)$/,
  /^packages\/shell\/(docktile|plugin-host)\//,
  /^packages\/ardiacore\/scripts\/([^/]+\.(sh|py)|signing\/.+|first-run-resources\.sha256)$/,
  /^packages\/ardiacore\/extensions\//,
  /^engine\/ardiacore\/src\/ardia\/core\/public\//,
  /^packages\/core-rs\//,
  /^scripts\/lib\/paths\.sh$/,
];
const DEPS = [/^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.npmrc|\.pnpmfile\.cjs)$/, /^patches\//, /^(apps|packages)\/[^/]+\/package\.json$/];
const PODS = [
  ...DEPS,
  /^apps\/browser\/macos\/(Podfile|Podfile\.lock|Podfile\.properties\.json)$/,
  /^apps\/browser\/(app\.json|react-native\.config\.js)$/,
  /^packages\/[^/]+\/ios\/.*\.podspec$/,
  /^packages\/[^/]+\/expo-module\.config\.json$/,
];
const POD_SOURCES = /^packages\/[^/]+\/ios\//;

export const isNative = (rel) => NATIVE.some((r) => r.test(rel));
const isDeps = (rel) => DEPS.some((r) => r.test(rel));
const isPodsInput = (rel) => PODS.some((r) => r.test(rel));

const BUILD_ENV = new RegExp(
  "^(RCT_|EXPO_|USE_|HERMES_|COCOAPODS_|SWIFT_|CLANG_|GCC_|OTHER_|BUNDLE_|ARDIACORE_(STAGE|PREBUILT|ENGINE_MATCH)|HSTS_|UBO_|UBOL_|RUST|CARGO_)|" +
    "^(NODE_BINARY|NODE_OPTIONS|ENTRY_FILE|SKIP_BUNDLING|FORCE_BUNDLING|EXTRA_PACKAGER_ARGS|EXTRA_COMPILER_ARGS|CONFIG_JSON|" +
    "ARDIA_PRUNE|CHROMIUM_TAG|TOOLCHAINS|DEVELOPER_DIR|SDKROOT|MACOSX_DEPLOYMENT_TARGET|CC|CXX|LD|CPP|CFLAGS|CXXFLAGS|" +
    "OBJCFLAGS|LDFLAGS|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|LIBRARY_PATH|CP_HOME_DIR|LANG|LC_ALL)$",
);
const UNFINGERPRINTABLE_ENV = ["XCODE_XCCONFIG_FILE", "ARDIA_CORE_RS_XCFRAMEWORK", "CARGO_TARGET_DIR"];
export const BUNDLING_ENV = /^(SKIP_BUNDLING|FORCE_BUNDLING|BUNDLE_[A-Z_]+|EXTRA_PACKAGER_ARGS|EXTRA_COMPILER_ARGS|ENTRY_FILE|CONFIG_JSON|USE_HERMES|HERMES_CLI_PATH|SOURCEMAP_FILE|NODE_ARGS|CLI_PATH)$/;
export const UNFINGERPRINTABLE_FILES = ["apps/browser/macos/.xcode.env.local", "apps/browser/macos/.xcode.env.updates"];

export function envFingerprint(env = process.env) {
  const blocked = [...UNFINGERPRINTABLE_ENV.filter((name) => env[name]), ...Object.keys(env).filter((name) => BUNDLING_ENV.test(name)).sort()];
  const lines = Object.keys(env)
    .filter((name) => BUILD_ENV.test(name))
    .sort()
    .map((name) => `env ${name}=${env[name]}`);
  return { lines, blocked };
}

export const defaults = (env = process.env) => ({
  cacheRoot: env.AC_APP_CACHE || join(homedir(), "ardia-scratch/app-cache"),
  slotRoot: env.AC_BUILD_SLOTS || join(homedir(), "ardia-scratch/build-slots"),
  maxBytes: Number(env.AC_APP_CACHE_MAX_GB || 40) * 1024 ** 3,
  maxEntries: Number(env.AC_APP_CACHE_MAX_ENTRIES || 16),
  keepEngines: Number(env.AC_APP_CACHE_MAX_ENGINES || 3),
  keepSlots: Number(env.AC_BUILD_SLOTS_KEEP || 3),
  graceMs: Number(env.AC_APP_CACHE_GRACE_MIN || 15) * 60e3,
});

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function contentId(path) {
  const st = fs.lstatSync(path);
  if (st.isSymbolicLink()) return `l:${sha256(fs.readlinkSync(path))}`;
  return `${st.mode & 0o111 ? "x" : "f"}:${sha256(fs.readFileSync(path))}`;
}

export function listFiles(repo) {
  const out = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

export function manifestOf(repo, files) {
  const manifest = {};
  for (const rel of files) {
    const path = join(repo, rel);
    let st;
    try {
      st = fs.lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    manifest[rel] = contentId(path);
  }
  return manifest;
}

export const pick = (manifest, keep) => Object.fromEntries(Object.entries(manifest).filter(([rel]) => keep(rel)));

function hashManifest(manifest, extra = []) {
  const h = createHash("sha256");
  for (const rel of Object.keys(manifest).sort()) h.update(`${rel}\0${manifest[rel]}\n`);
  for (const line of extra) h.update(`${line}\n`);
  return h.digest("hex");
}

export function depsHash(manifest, env = process.env) {
  return hashManifest(pick(manifest, isDeps), envFingerprint(env).lines);
}

export function podsHash(manifest, env = process.env) {
  const sources = Object.keys(manifest).filter((rel) => POD_SOURCES.test(rel));
  return hashManifest(pick(manifest, isPodsInput), [`deps ${depsHash(manifest, env)}`, ...sources.map((rel) => `source ${rel}`)]);
}

export class HashCache {
  constructor(path) {
    this.path = path;
    this.dirty = false;
    try {
      this.map = new Map(Object.entries(JSON.parse(fs.readFileSync(path, "utf8"))));
    } catch {
      this.map = new Map();
    }
  }
  fileHash(path, st) {
    const key = `${path}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    let hash = this.map.get(key);
    if (!hash) {
      hash = sha256(fs.readFileSync(path));
      this.map.set(key, hash);
      this.dirty = true;
    }
    return hash;
  }
  save(limit = 200000) {
    if (!this.dirty || !this.path) return;
    const entries = [...this.map.entries()].slice(-limit);
    fs.mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(tmp, this.path);
    this.dirty = false;
  }
}

function treeDigest(root, cache = new HashCache(null), { skipTop = [] } = {}) {
  const lines = [];
  const walk = (rel) => {
    const path = rel ? join(root, rel) : root;
    for (const name of fs.readdirSync(path).sort()) {
      if (!rel && skipTop.includes(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const child = join(path, name);
      const st = fs.lstatSync(child, { bigint: true });
      if (st.isSymbolicLink()) lines.push(`${childRel}\0l:${fs.readlinkSync(child)}`);
      else if (st.isDirectory()) walk(childRel);
      else lines.push(`${childRel}\0${Number(st.mode) & 0o111 ? "x" : "f"}:${cache.fileHash(child, st)}`);
    }
  };
  walk("");
  return sha256(lines.join("\n"));
}

export function frameworkIdentity(framework, cache) {
  if (!framework || !fs.existsSync(join(framework, "Versions/Current/Chromium Framework"))) return null;
  return `framework ${treeDigest(framework, cache)}`;
}

function toolchainIdentity() {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const parts = [
    run("xcodebuild", ["-version"]),
    run("xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
    run("xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
    run("xcrun", ["--find", "clang"]),
    run("xcrun", ["--find", "swiftc"]),
  ];
  if (parts.some((p) => p === null)) return null;
  return `toolchain ${parts.join(" | ").replace(/\s+/g, " ")}`;
}

function cargoConfigLines(env = process.env) {
  const home = env.CARGO_HOME || join(homedir(), ".cargo");
  const lines = [];
  for (const name of ["config.toml", "config"]) {
    try {
      lines.push(`cargo-config ${name} ${sha256(fs.readFileSync(join(home, name)))}`);
    } catch {}
  }
  return lines;
}

function runRust(core, env) {
  const runEnv = { ...env, PATH: `${join(homedir(), ".cargo/bin")}:${env.PATH ?? ""}`, RUSTUP_AUTO_INSTALL: "0" };
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: core, env: runEnv, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().replace(/\s+/g, " ") : null;
  };
}

export function rustIdentity(repo, env = process.env, { run = null, toolchain = undefined } = {}) {
  const core = join(repo, "packages/core-rs");
  if (!fs.existsSync(join(core, "rust-toolchain.toml"))) return "rust none";
  const exec = run ?? runRust(core, env);
  const rustc = exec("rustc", ["-vV"]);
  const cargo = exec("cargo", ["-V"]);
  const xcode = toolchain === undefined ? toolchainIdentity() : toolchain;
  if (!rustc || !cargo || !xcode) return null;
  const rustEnv = envFingerprint(env).lines.filter((l) => /^env (RUST|CARGO_)/.test(l));
  return ["rust", rustc, cargo, ...cargoConfigLines(env), ...rustEnv, xcode].join(" | ");
}

const xcframeworkReceipt = (tree) => join(tree, "packages/sync/ios/Frameworks/ArdiaCoreRS.xcframework.ac-identity");

export function receiptMatches(tree, identity) {
  if (!fs.existsSync(join(tree, "packages/core-rs/rust-toolchain.toml"))) return true;
  try {
    return fs.readFileSync(xcframeworkReceipt(tree), "utf8") === identity;
  } catch {
    return false;
  }
}

export function writeReceipt(tree, identity) {
  const path = xcframeworkReceipt(tree);
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, identity);
  fs.renameSync(tmp, path);
}

export function attemptPlan(candidates, wait) {
  const plan = candidates.map((slot) => ({ slot, wait: 1 }));
  if (candidates.length) plan.push({ slot: candidates[0], wait: Math.max(1, Math.min(60, wait)) });
  return plan;
}

export function stampOf({ manifest, config, signing = "default", framework, toolchain, rust = "rust none", env, native = isNative }) {
  return hashManifest(pick(manifest, native), [
    `stamp v${STAMP_VERSION}`,
    `config ${config}`,
    `signing ${signing}`,
    framework,
    toolchain,
    rust,
    ...env.lines,
  ]).slice(0, 32);
}

const GENERATED_ENV_FILE = /^export NODE_BINARY=\/[A-Za-z0-9_./@+-]+\n$/;

function localEnvLines(repo, files = UNFINGERPRINTABLE_FILES) {
  const lines = [];
  for (const rel of files) {
    let bytes;
    try {
      bytes = fs.readFileSync(join(repo, rel));
    } catch {
      continue;
    }
    if (!GENERATED_ENV_FILE.test(bytes.toString("latin1"))) return { blocked: `${rel} isn't the single absolute NODE_BINARY line pod install writes` };
    lines.push(`xcode-env ${rel} ${sha256(bytes)}`);
  }
  return { lines };
}

export function stampInputs({ framework, env = process.env, hashCache, toolchain = toolchainIdentity(), repo = null, rust = repo ? rustIdentity(repo, env, { toolchain }) : "rust none", localEnvFiles = UNFINGERPRINTABLE_FILES }) {
  const fingerprint = envFingerprint(env);
  if (fingerprint.blocked.length) return { blocked: `${fingerprint.blocked.join(", ")} set` };
  const local = repo ? localEnvLines(repo, localEnvFiles) : { lines: [] };
  if (local.blocked) return { blocked: local.blocked };
  fingerprint.lines.push(...local.lines);
  const identity = frameworkIdentity(framework, hashCache);
  if (!identity) return { blocked: `no engine framework at ${framework || "(none)"}` };
  if (!toolchain) return { blocked: "the Xcode toolchain didn't answer" };
  if (!rust) return { blocked: "the Rust toolchain rust-toolchain.toml pins didn't answer" };
  return { framework: identity, toolchain, rust, env: fingerprint };
}

const engineRecordField = (line, name) =>
  line
    .trim()
    .split(" ")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";

export function engineRecordComplete(path, key) {
  let line;
  try {
    line = fs.readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return engineRecordField(line, "key") === key && engineRecordField(line, "public_tree") !== "";
}

export function engineRecordNamesAnotherKey(path, key) {
  let line;
  try {
    line = fs.readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const recorded = engineRecordField(line, "key");
  return recorded !== "" && recorded !== key;
}

export function judgeSyncedEngine(repo, recorded, manifest) {
  const matchScript = join(repo, "packages/ardiacore/scripts/engine-match.sh");
  const judged = spawnSync(matchScript, ["resolve", repo, recorded], { encoding: "utf8" });
  if (judged.status !== 0) throw new Error(`judging the engine against the synced tree failed: ${judged.stderr.trim()}`);
  const line = judged.stdout.trim();
  if (hashManifest(manifestOf(repo, listFiles(repo))) !== hashManifest(manifest)) {
    throw new Error("the tree changed while its engine was judged after syncing; build again");
  }
  const checked = spawnSync(matchScript, ["check", line], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr.trim());
  return line;
}

export function describeEngineOffline(fetchEngine, key, commit) {
  const r = spawnSync(fetchEngine, ["--describe", "--offline"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
    env: { ...process.env, ARDIACORE_ENGINE_COMMIT: commit },
  });
  const line = r.status === 0 ? r.stdout.trim() : "";
  return /^match=(exact|nearest|unknown) /.test(line) && engineRecordField(line, "key") === key ? line : `match=unknown key=${key}`;
}

export function cloneTree(src, dst) {
  const args = process.platform === "darwin" ? ["-Rc", src, dst] : ["-a", "--reflink=auto", src, dst];
  return spawnSync("cp", args, { encoding: "utf8" });
}

const cloneOrThrow = (src, dst) => {
  const r = cloneTree(src, dst);
  if (r.status !== 0) throw new Error(`copying ${src} failed: ${r.stderr.trim()}`);
};

const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (path, value) => {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, path);
};

const cacheEntryDir = (cacheRoot, stamp) => join(cacheRoot, stamp);

const ENTRY_META = ["meta.json", ".used"];

export function lookup(cacheRoot, stamp) {
  const dir = cacheEntryDir(cacheRoot, stamp);
  const meta = readJson(join(dir, "meta.json"));
  if (!meta || meta.stamp !== stamp || !meta.digest || !fs.existsSync(join(dir, "Ardia.app/Contents/MacOS"))) return null;
  return { dir, app: join(dir, "Ardia.app"), meta };
}

export function touch(dir, now = new Date()) {
  try {
    const used = join(dir, ".used");
    fs.writeFileSync(used, "");
    fs.utimesSync(used, now, now);
    return true;
  } catch {
    return false;
  }
}

function duBytes(path) {
  const r = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.split(/\s/)[0]) * 1024 : 0;
}

const entryIntact = (entry) => {
  try {
    return treeDigest(entry.dir, undefined, { skipTop: ENTRY_META }) === entry.meta.digest;
  } catch {
    return false;
  }
};

export function withLock(path, fn, { timeoutMs = 60e3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(path);
      fs.writeFileSync(join(path, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(readJson(join(path, "pid"), 0));
      let age = 0;
      try {
        age = Date.now() - fs.statSync(path).mtimeMs;
      } catch {}
      if ((holder && !pidAlive(holder)) || (!holder && age > 60e3)) {
        fs.rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return { locked: false };
      spawnSync("sleep", ["0.1"]);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    fs.rmSync(path, { recursive: true, force: true });
  }
}

export function store(cacheRoot, stamp, app, meta = {}, { hermesc = null, measure = duBytes } = {}) {
  const existing = lookup(cacheRoot, stamp);
  if (existing && entryIntact(existing)) return { ...existing, existed: true };
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmp = join(cacheRoot, `.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp);
  try {
    cloneOrThrow(app, join(tmp, "Ardia.app"));
    if (hermesc && fs.existsSync(hermesc)) cloneOrThrow(hermesc, join(tmp, "hermesc"));
    const digest = treeDigest(tmp, undefined, { skipTop: ENTRY_META });
    fs.writeFileSync(join(tmp, "meta.json"), JSON.stringify({ ...meta, stamp, digest, created: new Date().toISOString(), bytes: measure(tmp) }, null, 1));
    touch(tmp);
    if (treeDigest(tmp, undefined, { skipTop: ENTRY_META }) !== digest) throw new Error("the new entry changed while it was written");
    const dir = cacheEntryDir(cacheRoot, stamp);
    withLock(join(cacheRoot, `.lock-${stamp}`), () => {
      const current = lookup(cacheRoot, stamp);
      if (current && entryIntact(current)) return;
      if (fs.existsSync(dir)) removeAtomically(cacheRoot, dir);
      fs.renameSync(tmp, dir);
    });
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  const entry = lookup(cacheRoot, stamp);
  if (!entry) throw new Error(`publishing ${stamp} left no entry`);
  return entry;
}

export function snapshotEntry(entry, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dirname(dest), { recursive: true });
  if (cloneTree(entry.dir, dest).status !== 0) return null;
  try {
    const meta = readJson(join(dest, "meta.json"));
    if (!meta || meta.stamp !== entry.meta.stamp || meta.digest !== entry.meta.digest) return null;
    if (treeDigest(dest, undefined, { skipTop: ENTRY_META }) !== meta.digest) return null;
    const hermesc = join(dest, "hermesc");
    return { app: join(dest, "Ardia.app"), hermesc: fs.existsSync(hermesc) ? hermesc : null, meta };
  } catch {
    return null;
  }
}

export const isInside = (path, root) => {
  try {
    const real = fs.realpathSync(path);
    const base = fs.realpathSync(root);
    return real === base || real.startsWith(`${base}/`);
  } catch {
    return false;
  }
};

export function linksLeaving(root) {
  const found = [];
  const base = fs.realpathSync(root);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync(path);
        } catch {}
        if (!target || !target.startsWith(`${base}/`)) found.push(`${path} -> ${target ?? "(unresolvable)"}`);
      } else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
}

export function stageEngine(cacheRoot, framework, cache) {
  const root = fs.realpathSync(framework);
  const leaving = linksLeaving(root);
  if (leaving.length) throw new Error(`${framework} has links that leave it (${leaving[0]}); stage a self-contained framework`);
  const digest = treeDigest(root, cache);
  const dir = join(cacheRoot, "engine-copies", digest.slice(0, 32));
  const copy = join(dir, "Chromium Framework.framework");
  let existing = fs.existsSync(join(dir, ".complete"));
  if (existing && (fs.lstatSync(copy, { throwIfNoEntry: false })?.isSymbolicLink() ?? true)) {
    removeAtomically(join(cacheRoot, "engine-copies"), dir);
    existing = false;
  }
  if (!existing) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      cloneOrThrow(root, join(tmp, "Chromium Framework.framework"));
      if (treeDigest(join(tmp, "Chromium Framework.framework"), cache) !== digest) throw new Error(`${framework} changed while it was copied`);
      fs.writeFileSync(join(tmp, ".complete"), digest);
      fs.renameSync(tmp, dir);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(join(dir, ".complete"))) throw e;
    }
  }
  touch(dir);
  return { copy, digest };
}

function listDirs(root, keep) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".") && keep(n)).map((n) => join(root, n));
}

const usedAt = (dir) => {
  try {
    return fs.statSync(join(dir, ".used")).mtimeMs;
  } catch {
    return 0;
  }
};

export function entries(cacheRoot) {
  return listDirs(cacheRoot, (n) => /^[0-9a-f]{32}$/.test(n)).map((dir) => {
    const entry = lookup(cacheRoot, dir.split("/").pop());
    return { stamp: dir.split("/").pop(), dir, bytes: entry?.meta.bytes ?? 0, usedAt: entry ? usedAt(dir) : 0, meta: entry?.meta ?? {} };
  });
}

export function evictionPlan(list, { maxBytes, maxEntries, protect = [], graceMs = 0, now = Date.now() }) {
  const sorted = [...list].sort((a, b) => b.usedAt - a.usedAt);
  const keep = [];
  const evict = [];
  let bytes = 0;
  for (const e of sorted) {
    const pinned = protect.includes(e.stamp) || now - e.usedAt < graceMs;
    if (pinned || (keep.length < maxEntries && bytes + e.bytes <= maxBytes)) {
      keep.push(e);
      bytes += e.bytes;
    } else evict.push(e);
  }
  return { keep, evict, bytes };
}

function removeAtomically(root, dir) {
  const trash = join(root, `.tmp-evict-${process.pid}-${Date.now()}-${dir.split("/").pop()}`);
  try {
    fs.renameSync(dir, trash);
  } catch {
    return;
  }
  fs.rmSync(trash, { recursive: true, force: true });
}

export function evict(cacheRoot, opts) {
  const plan = evictionPlan(entries(cacheRoot), opts);
  for (const e of plan.evict) removeAtomically(cacheRoot, e.dir);
  const evictedEngines = [];
  for (const [sub, pattern] of [["engines", /^[0-9a-f]{12}$/], ["engine-copies", /^[0-9a-f]{32}$/]]) {
    const root = join(cacheRoot, sub);
    const list = listDirs(root, (n) => pattern.test(n)).map((dir) => ({ stamp: basename(dir), dir, bytes: 0, usedAt: usedAt(dir) }));
    const protect = (opts.protectEngines ?? []).map((p) => basename(resolve(p)));
    const enginePlan = evictionPlan(list, { maxBytes: Infinity, maxEntries: opts.keepEngines ?? 3, graceMs: opts.graceMs, now: opts.now, protect });
    for (const e of enginePlan.evict) removeAtomically(root, e.dir);
    evictedEngines.push(...enginePlan.evict.map((e) => e.dir));
  }
  for (const root of [cacheRoot, join(cacheRoot, "engines"), join(cacheRoot, "engine-copies")]) {
    try {
      for (const name of fs.readdirSync(root)) {
        const path = join(root, name);
        if (/(^\.tmp-|\.tmp-\d+$)/.test(name) && Date.now() - fs.statSync(path).mtimeMs > 3600e3) fs.rmSync(path, { recursive: true, force: true });
      }
    } catch {}
  }
  return { ...plan, engines: evictedEngines };
}

function manifestDiff(from, to) {
  const changed = [];
  const removed = [];
  for (const [rel, id] of Object.entries(to)) if (from[rel] !== id) changed.push(rel);
  for (const rel of Object.keys(from)) if (!(rel in to)) removed.push(rel);
  return { changed: changed.sort(), removed: removed.sort() };
}

export const slotTree = (slot) => join(slot, "ardia");
export const slotDerivedData = (slot) => join(slotTree(slot), "apps/browser/build-slot");
const slotStatePath = (slot) => join(slot, "slot.json");
export const readSlotState = (slot) => readJson(slotStatePath(slot), { manifest: {}, pending: [], syncedAt: 0 });
export const writeSlotState = (slot, state) => {
  fs.mkdirSync(slot, { recursive: true });
  writeJsonAtomic(slotStatePath(slot), state);
};

export function lockHolderPath(derivedData, root = process.env.AC_LOCK_ROOT || "/tmp") {
  const base = derivedData.replace(/\/+$/, "").split("/").pop();
  const digest = createHash("sha1").update(derivedData.replace(/\/+$/, "")).digest("hex").slice(0, 8);
  return join(root, `ac-xcodebuild-${base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)}-${digest}.holder`);
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

export function canonical(path) {
  try {
    return fs.realpathSync(path);
  } catch {
    try {
      return join(fs.realpathSync(dirname(path)), path.split("/").pop());
    } catch {
      return path;
    }
  }
}

export const slotGroupFile = (slot) => join(slot, "children.pgid");

export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export const slotGroup = (slot) => Number(readJson(slotGroupFile(slot), {}).pgid);

const GROUP_WRAPPER = 'setpgrp(0, 0); my $f = shift; open(my $h, ">", $f) or die "$f: $!"; print $h "{\\"pgid\\":$$}"; close $h; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!";';

export function groupCommand(slot, cmd, args) {
  if (settleGroup(slot)) return null;
  return ["perl", ["-e", GROUP_WRAPPER, slotGroupFile(slot), cmd, ...args]];
}

export function settleGroup(slot) {
  if (!fs.existsSync(slotGroupFile(slot))) return false;
  if (groupAlive(slotGroup(slot))) return true;
  fs.rmSync(slotGroupFile(slot), { force: true });
  return false;
}

export function slotBusy(slot, { root } = {}) {
  const reserved = Number(readJson(join(slot, "reserved.json"), {}).pid);
  if (pidAlive(reserved) || groupAlive(slotGroup(slot))) return true;
  let holder;
  try {
    holder = fs.readFileSync(lockHolderPath(canonical(slotDerivedData(slot)), root), "utf8");
  } catch {
    return false;
  }
  const [kind, value] = holder.trim().split(/\s+/);
  if (kind === "pid") return pidAlive(Number(value));
  if (kind === "take") return Number(value) * 1000 > Date.now();
  return false;
}

export const listSlots = (slotRoot) => listDirs(slotRoot, (n) => /^\d+$/.test(n)).sort((a, b) => Number(a.split("/").pop()) - Number(b.split("/").pop()));

function rankSlots(slots, manifest, { busy = slotBusy, readState = readSlotState } = {}) {
  return slots
    .map((slot) => {
      const state = readState(slot);
      const { changed, removed } = manifestDiff(state.manifest ?? {}, manifest);
      return { slot, busy: busy(slot), distance: changed.length + removed.length, usedAt: state.syncedAt ?? 0 };
    })
    .sort((a, b) => a.busy - b.busy || a.distance - b.distance || b.usedAt - a.usedAt);
}

export function freeSlots(slotRoot, manifest, opts = {}) {
  return rankSlots(listSlots(slotRoot), manifest, opts)
    .filter((r) => !r.busy)
    .map((r) => r.slot);
}

export function reserveSlot(slotRoot, owner) {
  fs.mkdirSync(slotRoot, { recursive: true });
  for (let n = 1; n < 10000; n++) {
    const slot = join(slotRoot, String(n));
    try {
      fs.mkdirSync(slot);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
    writeJsonAtomic(join(slot, "reserved.json"), { pid: owner });
    return slot;
  }
  throw new Error(`no free slot number under ${slotRoot}`);
}

export function appRunnable(app) {
  try {
    const plist = fs.readFileSync(join(app, "Contents/Info.plist"), "utf8");
    const exe = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!exe) return false;
    const st = fs.statSync(join(app, "Contents/MacOS", exe));
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function slotDroppable(slot) {
  if (pidAlive(Number(readJson(join(slot, "reserved.json"), {}).pid))) return false;
  if (fs.existsSync(slotGroupFile(slot)) && groupAlive(slotGroup(slot))) return false;
  return true;
}

export const releaseReservation = (slot) => fs.rmSync(join(slot, "reserved.json"), { force: true });

export function slotsToEvict(slotRoot, { keep, busy = slotBusy, readState = readSlotState, protect = [] } = {}) {
  const idle = listSlots(slotRoot)
    .filter((s) => !protect.includes(s) && !busy(s))
    .map((slot) => ({ slot, usedAt: readState(slot).syncedAt ?? 0 }))
    .sort((a, b) => b.usedAt - a.usedAt);
  const kept = keep - protect.length;
  return idle.slice(Math.max(0, kept)).map((s) => s.slot);
}

export const slotScratch = (slot) => join(slot, "tmp");

function copyInto(srcRepo, dstRepo, rel, now, scratchDir) {
  const src = join(srcRepo, rel);
  const dst = join(dstRepo, rel);
  fs.mkdirSync(dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  const tmp = join(scratchDir, `${process.pid}-${createHash("sha1").update(rel).digest("hex")}`);
  fs.rmSync(tmp, { force: true });
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), tmp);
  } else {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tmp, st.mode & 0o7777);
    fs.utimesSync(tmp, now, now);
  }
  try {
    if (fs.lstatSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
  } catch {}
  fs.renameSync(tmp, dst);
}

function pruneEmptyDirs(root, rel) {
  let dir = dirname(rel);
  while (dir && dir !== ".") {
    try {
      fs.rmdirSync(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

function linkedAncestor(tree, rel) {
  const parts = rel.split("/").slice(0, -1);
  let path = tree;
  for (const part of parts) {
    path = join(path, part);
    try {
      if (fs.lstatSync(path).isSymbolicLink()) return path;
    } catch {
      return null;
    }
  }
  return null;
}

export function driftedPaths(tree, state) {
  const drifted = [];
  const since = state.syncedAt ?? 0;
  for (const [rel, id] of Object.entries(state.manifest ?? {})) {
    let st;
    try {
      st = fs.lstatSync(join(tree, rel));
    } catch {
      drifted.push(rel);
      continue;
    }
    if (st.isDirectory()) drifted.push(rel);
    else if ((st.mtimeMs > since || st.ctimeMs > since) && contentId(join(tree, rel)) !== id) drifted.push(rel);
  }
  return drifted;
}

export function syncTree(srcRepo, slot, manifest, { now = new Date() } = {}) {
  const tree = slotTree(slot);
  fs.mkdirSync(tree, { recursive: true });
  const scratchDir = slotScratch(slot);
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const state = readSlotState(slot);
  const prior = state.manifest ?? {};
  const pending = new Set(state.pending ?? []);
  const drifted = new Set(driftedPaths(tree, state));
  const base = Object.fromEntries(Object.entries(prior).filter(([rel]) => !drifted.has(rel) && !pending.has(rel)));
  const changed = Object.keys(manifest).filter((rel) => base[rel] !== manifest[rel]).sort();
  const managed = new Set([...Object.keys(prior), ...pending]);
  const removed = [...managed].filter((rel) => !(rel in manifest)).sort();
  writeSlotState(slot, { ...state, pending: [...new Set([...pending, ...changed])] });
  for (const rel of removed) {
    if (linkedAncestor(tree, rel)) continue;
    fs.rmSync(join(tree, rel), { force: true, recursive: true });
    pruneEmptyDirs(tree, rel);
  }
  for (const rel of changed) {
    const link = linkedAncestor(tree, rel);
    if (link) throw new Error(`${link} is a symlink in the slot where ${rel} needs a folder`);
    copyInto(srcRepo, tree, rel, now, scratchDir);
  }
  const mismatched = changed.filter((rel) => {
    try {
      return contentId(join(tree, rel)) !== manifest[rel];
    } catch {
      return true;
    }
  });
  const settled = Object.fromEntries(Object.entries(manifest).filter(([rel]) => !mismatched.includes(rel)));
  writeSlotState(slot, { ...state, manifest: settled, pending: mismatched, syncedAt: Date.now() + 1 });
  return { changed, removed, drifted: [...drifted], mismatched };
}

const NODE_MODULES_ROOTS = (root) => [
  "node_modules",
  ...["apps", "packages"].flatMap((d) => {
    try {
      if (fs.lstatSync(join(root, d)).isSymbolicLink()) throw new Error(`${join(root, d)} is a symlink: its node_modules aren't this tree's`);
      return fs.readdirSync(join(root, d)).map((n) => `${d}/${n}/node_modules`);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }),
].filter((rel) => {
  const link = linkedAncestor(root, rel);
  if (link) throw new Error(`${link} is a symlink: its node_modules aren't this tree's`);
  try {
    fs.lstatSync(join(root, rel));
    return true;
  } catch {
    return false;
  }
});

export function escapingLinks(root, { deep = false, limit = 5 } = {}) {
  const found = [];
  let base;
  try {
    base = fs.realpathSync(root) + "/";
  } catch {
    return [`${root} -> (unresolvable)`];
  }
  const check = (path) => {
    let target;
    try {
      target = fs.realpathSync(path);
    } catch {
      target = null;
    }
    if (!target || !target.startsWith(base)) found.push(`${path} -> ${target ?? "(unresolvable)"}`);
  };
  const visit = (path, depth) => {
    if (found.length >= limit) return;
    let st;
    try {
      st = fs.lstatSync(path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return check(path);
    if (!st.isDirectory()) return;
    if (!deep && depth > 1) return;
    for (const name of fs.readdirSync(path)) {
      const nextDepth = name.startsWith("@") || name === ".bin" ? depth : depth + 1;
      visit(join(path, name), nextDepth);
      if (found.length >= limit) return;
    }
  };
  for (const rel of NODE_MODULES_ROOTS(root)) visit(join(root, rel), 0);
  return found;
}

export const nodeModulesRoots = NODE_MODULES_ROOTS;
