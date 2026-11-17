#!/usr/bin/env node
// Keeps a phone bundle to a committed tree: Metro must only ever read what HEAD holds.
//
//   node apps/phone/scripts/bundle-guard.ts check  [--root REPO]
//   node apps/phone/scripts/bundle-guard.ts dirty  [--root REPO]
//   node apps/phone/scripts/bundle-guard.ts before --state FILE [--expect COMMIT] [--root REPO]
//   node apps/phone/scripts/bundle-guard.ts after  --state FILE [--root REPO]
//   node apps/phone/scripts/bundle-guard.ts native [--since EPOCH_MS] [--root REPO]
//
// check refuses (exit 1) when git shows any change, staged, unstaged or untracked, under the files Metro reads,
// and prints them. dirty prints yes or no. before runs check, then records HEAD, a hash of those files and the
// start time in FILE. after fails when HEAD or the hash moved, or when any of those files was written after the
// start, which also catches an edit that was reverted before the bundle finished. native prints HEAD and whether
// the native trees a build compiles from the working tree are clean, and with --since which of them were written
// after that moment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const watchedPaths = [
  "apps/phone/src",
  "apps/phone/index.js",
  "apps/phone/app.json",
  "apps/phone/package.json",
  "apps/phone/babel.config.js",
  "apps/phone/metro.config.js",
  "packages/phone/src",
  "packages/phone/package.json",
  "packages/core/src",
  "packages/core/package.json",
  "apps/phone/pnpm-lock.yaml",
  "apps/phone/pnpm-workspace.yaml",
];

export const nativePaths = [
  "apps/phone/android",
  "apps/phone/app.json",
  "packages/phone/android",
  "packages/phone/expo-module.config.json",
  "apps/phone/pnpm-lock.yaml",
  "apps/phone/pnpm-workspace.yaml",
  "patches",
];

export class BundleRefused extends Error {}

export function nativeState(root: string, since?: number, paths: string[] = nativePaths): string {
  const commit = headCommit(root);
  const changed = changedPaths(root, paths);
  const touched = since === undefined ? [] : fingerprint(root, paths).files.filter(({ mtimeMs }) => mtimeMs >= since).map(({ file }) => file);
  const parts = [commit, changed.length === 0 ? "clean" : `dirty (${changed.length}: ${changed.map((line) => line.slice(3)).join(", ")})`];
  if (touched.length > 0) parts.push(`written during the build (${touched.length}: ${touched.join(", ")})`);
  return parts.join(", ");
}

type GuardState = { commit: string; hash: string; startedAt: number };

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function headCommit(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function changedPaths(root: string, paths: string[] = watchedPaths): string[] {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", "--", ...paths]);
  const entries = out.split("\0");
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    changed.push(`${status} ${entry.slice(3)}`);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return changed;
}

function trackedAndUntracked(root: string, paths: string[]): string[] {
  return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths])
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function fingerprint(root: string, paths: string[] = watchedPaths): { hash: string; files: { file: string; mtimeMs: number }[] } {
  const hash = createHash("sha256");
  const files: { file: string; mtimeMs: number }[] = [];
  for (const file of new Set(trackedAndUntracked(root, paths))) {
    const full = path.join(root, file);
    hash.update(file).update("\0");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      hash.update("missing\0");
      continue;
    }
    files.push({ file, mtimeMs: stat.mtimeMs });
    hash.update(stat.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : fs.readFileSync(full)).update("\0");
  }
  return { hash: hash.digest("hex"), files };
}

export function check(root: string, paths: string[] = watchedPaths): void {
  const changed = changedPaths(root, paths);
  if (changed.length > 0) {
    throw new BundleRefused(
      [`refusing to bundle: ${changed.length} uncommitted change(s) Metro would read. Commit them, or let their owner commit them, then build again:`, ...changed.map((line) => `  ${line}`)].join("\n"),
    );
  }
}

export function before(root: string, stateFile: string, expect?: string, paths: string[] = watchedPaths, now = Date.now()): GuardState {
  check(root, paths);
  const commit = headCommit(root);
  if (expect && expect !== commit) {
    throw new BundleRefused(`refusing to bundle: HEAD is ${commit}, but the build stamped ${expect}. Run the build again from one commit.`);
  }
  const state: GuardState = { commit, hash: fingerprint(root, paths).hash, startedAt: now };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return state;
}

export function after(root: string, stateFile: string, paths: string[] = watchedPaths): GuardState {
  if (!fs.existsSync(stateFile)) throw new BundleRefused(`the bundle has no guard record at ${stateFile}: the before step never ran`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as GuardState;
  fs.rmSync(stateFile, { force: true });
  const problems: string[] = [];
  const commit = headCommit(root);
  if (commit !== state.commit) problems.push(`HEAD moved from ${state.commit} to ${commit}`);
  const now = fingerprint(root, paths);
  if (now.hash !== state.hash) problems.push("the files Metro reads changed");
  const touched = now.files.filter(({ mtimeMs }) => mtimeMs >= state.startedAt).map(({ file }) => file);
  if (touched.length > 0) problems.push(`written while the bundle was being made:\n${touched.map((file) => `    ${file}`).join("\n")}`);
  const changed = changedPaths(root, paths);
  if (changed.length > 0) problems.push(`uncommitted now:\n${changed.map((line) => `    ${line}`).join("\n")}`);
  if (problems.length > 0) {
    throw new BundleRefused(["the bundle may not match a commit, so the build fails:", ...problems.map((line) => `  ${line}`)].join("\n"));
  }
  return state;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv: string[]): number {
  const command = argv[0];
  const root = option(argv, "--root") ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const stateFile = option(argv, "--state");
  try {
    if (command === "check") check(root);
    else if (command === "dirty") console.log(changedPaths(root).length > 0 ? "yes" : "no");
    else if (command === "native") {
      const since = option(argv, "--since");
      console.log(nativeState(root, since === undefined ? undefined : Number(since)));
    }
    else if (command === "before" && stateFile) {
      const state = before(root, stateFile, option(argv, "--expect"));
      console.log(`bundle-guard: bundling ${state.commit}, dirty: no`);
    } else if (command === "after" && stateFile) {
      const state = after(root, stateFile);
      console.log(`bundle-guard: bundle matches ${state.commit}`);
    } else {
      const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
      console.log(lines.filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
      return command === "--help" || command === "-h" ? 0 : 64;
    }
    return 0;
  } catch (error) {
    if (error instanceof BundleRefused) {
      console.error(`bundle-guard: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
