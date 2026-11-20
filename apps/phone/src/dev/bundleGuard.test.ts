import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after as afterAll, test } from "node:test";
import { fileURLToPath } from "node:url";
import { after, before, BundleRefused, check } from "../../scripts/bundle-guard.ts";

const guardScript = fileURLToPath(new URL("../../scripts/bundle-guard.ts", import.meta.url));


const made: string[] = [];
afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function repo(): { root: string; state: string; write: (file: string, text: string) => void; git: (...args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-guard-"));
  made.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  git("init", "-q");
  git("config", "user.email", "guard@example.com");
  git("config", "user.name", "guard");
  write("apps/phone/src/App.tsx", "export default 1;\n");
  write("packages/phone/src/index.ts", "export {};\n");
  write("packages/core/src/index.ts", "export {};\n");
  write("apps/phone/package.json", "{}\n");
  write("apps/phone/pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("packages/phone/ios/SyncModule.swift", "let a = 1\n");
  write(".gitignore", "build/\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  const anHourAgo = new Date(Date.now() - 3_600_000);
  for (const file of git("ls-files").split("\n").filter(Boolean)) fs.utimesSync(path.join(root, file), anHourAgo, anHourAgo);
  return { root, state: path.join(root, "build", "guard.json"), write, git };
}

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BundleRefused, String(error));
    return error.message;
  }
  assert.fail("the guard let the bundle through");
};

test("a committed tree bundles, and the record names its commit", () => {
  const { root, state, git } = repo();
  const started = before(root, state);
  assert.equal(started.commit, git("rev-parse", "HEAD").trim());
  assert.equal(after(root, state).commit, started.commit);
});

test("a modified, a staged and an untracked file under the bundled trees each refuse, with their paths", () => {
  const { root, state, write, git } = repo();
  write("apps/phone/src/App.tsx", "export default 2;\n");
  write("packages/core/src/index.ts", "export const staged = 1;\n");
  git("add", "packages/core/src/index.ts");
  write("packages/phone/src/new.ts", "export {};\n");
  const message = refusal(() => before(root, state));
  assert.match(message, / M apps\/phone\/src\/App\.tsx/);
  assert.match(message, /M  packages\/core\/src\/index\.ts/);
  assert.match(message, /\?\? packages\/phone\/src\/new\.ts/);
  assert.equal(fs.existsSync(state), false);
});

test("a changed lockfile refuses", () => {
  const { root, write } = repo();
  write("apps/phone/pnpm-lock.yaml", "lockfileVersion: 10\n");
  assert.match(refusal(() => check(root)), /apps\/phone\/pnpm-lock\.yaml/);
});

test("another agent's native files and ignored output do not block the bundle", () => {
  const { root, state, write } = repo();
  write("packages/phone/ios/SyncModule.swift", "let a = 2\n");
  write("build/out.txt", "x\n");
  before(root, state);
  after(root, state);
});

test("an edit made and reverted while the bundle was being made fails the build", () => {
  const { root, state, write } = repo();
  before(root, state, undefined, undefined, Date.now() - 5_000);
  write("apps/phone/src/App.tsx", "export default 2;\n");
  write("apps/phone/src/App.tsx", "export default 1;\n");
  const message = refusal(() => after(root, state));
  assert.match(message, /written while the bundle was being made:\n\s+apps\/phone\/src\/App\.tsx/);
});

test("a commit landing while the bundle was being made fails the build", () => {
  const { root, state, write, git } = repo();
  const started = before(root, state);
  write("packages/phone/ios/SyncModule.swift", "let a = 3\n");
  git("commit", "-qam", "second");
  assert.match(refusal(() => after(root, state)), new RegExp(`HEAD moved from ${started.commit}`));
});

test("a bundle for a commit other than the one the build stamped is refused", () => {
  const { root, state } = repo();
  assert.match(refusal(() => before(root, state, "0000000")), /the build stamped 0000000/);
});

test("the after step without a before step fails", () => {
  const { root, state } = repo();
  assert.match(refusal(() => after(root, state)), /before step never ran/);
});

test("the command refuses with exit 1 and prints the offending paths", () => {
  const { root, write } = repo();
  write("apps/phone/src/App.tsx", "export default 2;\n");
  const run = spawnSync(process.execPath, ["--no-warnings", guardScript, "check", "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to bundle: 1 uncommitted change/);
  assert.match(run.stderr, /apps\/phone\/src\/App\.tsx/);
  const dirty = spawnSync(process.execPath, ["--no-warnings", guardScript, "dirty", "--root", root], { encoding: "utf8" });
  assert.equal(dirty.stdout.trim(), "yes");
});
