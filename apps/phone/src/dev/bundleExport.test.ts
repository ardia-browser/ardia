import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createExport, exportCommit, removeExport } from "../../scripts/bundle-export.ts";
import { nativeState } from "../../scripts/bundle-guard.ts";


const made: string[] = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-export-repo-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-export-out-"));
  made.push(root, parent);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  git("init", "-q");
  git("config", "user.email", "export@example.com");
  git("config", "user.name", "export");
  write("package.json", "{}\n");
  write("pnpm-workspace.yaml", "packages: []\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("apps/phone/pnpm-workspace.yaml", "packages: []\n");
  write("apps/phone/pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("patches/a.patch", "x\n");
  write("apps/phone/index.js", "require('./src/App');\n");
  write("apps/phone/src/App.tsx", "export default 'first';\n");
  write("apps/phone/android/app/build.gradle", "native\n");
  write("packages/phone/src/index.ts", "export {};\n");
  write("packages/phone/android/Module.kt", "native\n");
  write("packages/core/src/index.ts", "export {};\n");
  write("apps/browser/src/index.ts", "mac\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD").trim();
  return { root, parent, git, write, first };
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

test("an export holds the commit's JavaScript, not an edit in the working tree, and leaves native and other apps out", () => {
  const { root, parent, write, first } = repo();
  write("apps/phone/src/App.tsx", "export default 'half-edited';\n");
  write("apps/phone/src/New.tsx", "untracked\n");
  const made = createExport(root, "HEAD", { install: false, parent });
  assert.equal(made.commit, first);
  assert.equal(exportCommit(made.dir), first);
  assert.equal(read(made.dir, "apps/phone/src/App.tsx"), "export default 'first';\n");
  assert.equal(fs.existsSync(path.join(made.dir, "apps/phone/src/New.tsx")), false);
  for (const kept of ["apps/phone/pnpm-workspace.yaml", "apps/phone/pnpm-lock.yaml", "patches/a.patch", "apps/phone/index.js", "packages/phone/src/index.ts", "packages/core/src/index.ts"]) {
    assert.ok(fs.existsSync(path.join(made.dir, kept)), kept);
  }
  for (const left of ["apps/phone/android", "packages/phone/android", "apps/browser", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    assert.equal(fs.existsSync(path.join(made.dir, left)), false, left);
  }
  assert.equal(made.dir, fs.realpathSync(made.dir));
});

test("an export of an older commit has that commit's files, whatever HEAD is now", () => {
  const { root, parent, git, write, first } = repo();
  write("apps/phone/src/App.tsx", "export default 'second';\n");
  git("commit", "-qam", "second");
  const older = createExport(root, first, { install: false, parent });
  const newer = createExport(root, "HEAD", { install: false, parent });
  assert.equal(read(older.dir, "apps/phone/src/App.tsx"), "export default 'first';\n");
  assert.equal(read(newer.dir, "apps/phone/src/App.tsx"), "export default 'second';\n");
});

test("an unknown commit makes no export", () => {
  const { root, parent } = repo();
  assert.throws(() => createExport(root, "no-such-ref", { install: false, parent }));
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("remove deletes an export and refuses any other folder", () => {
  const { root, parent } = repo();
  const made = createExport(root, "HEAD", { install: false, parent });
  assert.throws(() => removeExport(root), /not a bundle export/);
  assert.ok(fs.existsSync(path.join(root, "package.json")));
  const lookalike = fs.mkdtempSync(path.join(parent, "ardia-bundle-lookalike-"));
  assert.throws(() => removeExport(lookalike), /not a bundle export/);
  removeExport(made.dir);
  assert.equal(fs.existsSync(made.dir), false);
});

test("the native state names HEAD and a half-edited or freshly written native file", () => {
  const { root, write, first } = repo();
  const anHourAgo = new Date(Date.now() - 3_600_000);
  for (const file of execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)) {
    fs.utimesSync(path.join(root, file), anHourAgo, anHourAgo);
  }
  assert.equal(nativeState(root, Date.now() - 60_000), `${first}, clean`);
  write("packages/phone/android/Module.kt", "half\n");
  write("apps/phone/src/App.tsx", "javascript is not native\n");
  assert.equal(nativeState(root, Date.now() - 60_000), `${first}, dirty (1: packages/phone/android/Module.kt), written during the build (1: packages/phone/android/Module.kt)`);
});
