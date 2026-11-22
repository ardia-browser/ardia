#!/usr/bin/env node
// Makes a scratch copy of one commit's JavaScript trees for an Android bundle, so Metro never reads the working tree.
//
//   node apps/phone/scripts/bundle-export.ts create [--commit REV] [--root REPO] [--no-install]
//   node apps/phone/scripts/bundle-export.ts remove DIR
//
// create resolves REV (default HEAD), extracts the phone app with its own workspace file and lockfile, its
// packages and the patches from that commit with git archive into a new folder under the system temp folder,
// runs pnpm install --offline --frozen-lockfile in the phone's workspace there,
// and prints {"dir": …, "commit": …}. Pass the dir to Gradle as -PardiaBundleExport=DIR. remove deletes a folder
// that create made, and refuses anything else.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const exportPaths = [
  "patches",
  "apps/phone",
  ":(exclude)apps/phone/android",
  ":(exclude)apps/phone/ios",
  "packages/phone",
  ":(exclude)packages/phone/android",
  ":(exclude)packages/phone/ios",
  "packages/core",
];

export const EXPORT_PREFIX = "ardia-bundle-";
export const EXPORT_RECORD = ".ardia-bundle.json";

export type BundleExport = { dir: string; commit: string };

export function resolveCommit(root: string, rev = "HEAD"): string {
  return execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
}

export function createExport(root: string, rev = "HEAD", options: { install?: boolean; parent?: string } = {}): BundleExport {
  const commit = resolveCommit(root, rev);
  const parent = fs.realpathSync(options.parent ?? os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, `${EXPORT_PREFIX}${commit.slice(0, 9)}-`));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", commit, "--", ...exportPaths], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive });
    fs.writeFileSync(path.join(dir, EXPORT_RECORD), JSON.stringify({ commit }));
    if (options.install !== false) {
      execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile", "--reporter=silent"], { cwd: path.join(dir, "apps/phone"), stdio: ["ignore", 2, 2] });
    }
    return { dir, commit };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function exportCommit(dir: string): string {
  return (JSON.parse(fs.readFileSync(path.join(dir, EXPORT_RECORD), "utf8")) as { commit: string }).commit;
}

export function removeExport(dir: string): void {
  const resolved = fs.realpathSync(dir);
  if (!path.basename(resolved).startsWith(EXPORT_PREFIX) || !fs.existsSync(path.join(resolved, EXPORT_RECORD))) {
    throw new Error(`${dir} is not a bundle export, so it is left alone`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv: string[]): number {
  const command = argv[0];
  if (command === "create") {
    const root = option(argv, "--root") ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    console.log(JSON.stringify(createExport(root, option(argv, "--commit") ?? "HEAD", { install: !argv.includes("--no-install") })));
    return 0;
  }
  if (command === "remove" && argv[1]) {
    removeExport(argv[1]);
    return 0;
  }
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
  return command === "--help" || command === "-h" ? 0 : 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
