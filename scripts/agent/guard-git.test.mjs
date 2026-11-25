import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "guard-git");
const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-git-")));
const shared = join(root, "shared");
const worktree = join(root, "worktree");
const clone = join(root, "clone");
const linked = join(root, "linked-guard");

function git(directory, ...args) {
  execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
}

mkdirSync(join(shared, "scripts", "agent"), { recursive: true });
mkdirSync(join(shared, "apps"));
copyFileSync(source, join(shared, "scripts", "agent", "guard-git"));
git(shared, "init", "-q", "-b", "work");
git(shared, "add", "scripts");
git(shared, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
git(shared, "worktree", "add", "-q", "-b", "feature", worktree);
git(root, "clone", "-q", shared, clone);
symlinkSync(join(shared, "scripts", "agent", "guard-git"), linked);

test.after(() => rmSync(root, { recursive: true, force: true }));

const guardOf = (checkout) => join(checkout, "scripts", "agent", "guard-git");

function verdict(command, cwd = shared, { guard = guardOf(shared), project = shared } = {}) {
  const env = { ...process.env };
  if (project === null) delete env.CLAUDE_PROJECT_DIR;
  else env.CLAUDE_PROJECT_DIR = project;
  const result = spawnSync("python3", [guard], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: "utf8", env });
  return result.status === 2 ? "blocked" : result.status === 0 ? "allowed" : `status ${result.status}: ${result.stderr}`;
}

test("destructive commands stay blocked in the shared checkout and its subfolders", () => {
  for (const command of [
    "git checkout -- README.md",
    "git switch main",
    "git restore README.md",
    "git stash",
    "git reset --hard HEAD",
    "git clean -fd",
    "echo hi && git switch main",
  ]) {
    assert.equal(verdict(command), "blocked", command);
    assert.equal(verdict(command, join(shared, "apps")), "blocked", command);
  }
});

test("safe forms pass in the shared checkout", () => {
  for (const command of ["git checkout -b topic", "git restore --staged README.md", "git status", "git show HEAD:README.md"]) {
    assert.equal(verdict(command), "allowed", command);
  }
});

test("a linked worktree and a separate clone may switch, reset, stash and clean", () => {
  for (const command of ["git switch main", "git checkout -- a.txt", "git reset --hard HEAD", "git stash", "git clean -fd", "git restore a.txt"]) {
    assert.equal(verdict(command, worktree), "allowed", `worktree: ${command}`);
    assert.equal(verdict(command, clone), "allowed", `clone: ${command}`);
  }
});

test("the directory a command moves to decides, by cd or git -C", () => {
  assert.equal(verdict(`cd ${worktree} && git switch main`), "allowed");
  assert.equal(verdict(`cd "${clone}" && git reset --hard HEAD`), "allowed");
  assert.equal(verdict(`git -C ${worktree} switch main`), "allowed");
  assert.equal(verdict(`git -C ${shared} switch main`, worktree), "blocked");
  assert.equal(verdict(`cd ${shared} && git stash`, clone), "blocked");
  assert.equal(verdict(`cd ${worktree} && cd ../shared && git clean -fd`, clone), "blocked");
  assert.equal(verdict(`cd ${worktree} && git switch main; cd ${shared} && git stash`), "blocked");
});

test("relative paths resolve from where the command already is", () => {
  assert.equal(verdict("cd ../shared/apps && git stash", worktree), "blocked");
  assert.equal(verdict("cd ../worktree && git switch main", shared), "allowed");
  assert.equal(verdict("git -C ../clone reset --hard HEAD", shared), "allowed");
  assert.equal(verdict("cd apps && cd .. && git stash", shared), "blocked");
  assert.equal(verdict("cd .. && cd shared && git clean -fd", clone), "blocked");
});

test("a subshell's cd ends with the subshell", () => {
  assert.equal(verdict(`(cd ${worktree} && git switch main)`), "allowed");
  assert.equal(verdict(`(cd ${worktree}); git switch main`), "blocked");
  assert.equal(verdict(`echo $(cd ${worktree}) && git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && (cd ${shared}) && git stash`), "allowed");
  assert.equal(verdict(`(cd ${worktree} && echo ")" && git switch main)`), "allowed");
  assert.equal(verdict(`cd ${worktree} && (cd ${shared} && git stash)`), "blocked");
});

test("pushd, popd and cd - follow the directory stack", () => {
  assert.equal(verdict(`pushd ${worktree} && git switch main`), "allowed");
  assert.equal(verdict(`pushd ${worktree} && popd && git switch main`), "blocked");
  assert.equal(verdict(`cd ${worktree} && pushd ${shared} && popd && git stash`), "allowed");
  assert.equal(verdict(`pushd ${worktree} && pushd ${clone} && pushd && git stash`), "allowed");
  assert.equal(verdict(`pushd ${worktree} >/dev/null; popd >/dev/null; git clean -fd`), "blocked");
  assert.equal(verdict(`cd ${worktree} && cd - && git stash`), "blocked");
  assert.equal(verdict(`cd ${shared} && cd - && git stash`, clone), "allowed");
});

test("quoted text that only shows a git command is not a git command", () => {
  for (const command of [
    'echo "git checkout -- x"',
    "echo 'git switch main'",
    'printf "%s\\n" "run git stash, then git reset --hard"',
    'gh pr comment 1 --body "please git clean -fd first"',
    "git log --grep='git reset --hard'",
    'git commit -m "undo with git checkout -- file"',
  ]) {
    assert.equal(verdict(command), "allowed", command);
  }
});

test("command substitutions are commands, quoted or not", () => {
  assert.equal(verdict('echo "$(git stash)"'), "blocked");
  assert.equal(verdict("x=$(git switch main)"), "blocked");
  assert.equal(verdict("echo `git clean -fd`"), "blocked");
  assert.equal(verdict('echo "`git reset --hard`"'), "blocked");
  assert.equal(verdict(`echo "$(cd ${worktree} && git switch main)"`), "allowed");
  assert.equal(verdict(`cd ${worktree} && echo "$(git stash)"`), "allowed");
  assert.equal(verdict(`echo "$(cd ${worktree})" && git stash`), "blocked");
});

test("a cd that may fail keeps the old directory in play", () => {
  assert.equal(verdict(`cd ${worktree}; git switch main`), "blocked");
  assert.equal(verdict(`cd ${worktree}\ngit switch main`), "blocked");
  assert.equal(verdict(`cd ${worktree} || git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && git switch main`), "allowed");
  assert.equal(verdict(`cd ${shared}; git stash`, clone), "blocked");
  assert.equal(verdict(`cd ${root}/missing; git stash`, clone), "allowed");
  assert.equal(verdict(`cd ${worktree} | cat && git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} || exit 1; git switch main`), "allowed");
  assert.equal(verdict(`cd ${worktree} || return; git switch main`), "allowed");
  assert.equal(verdict(`cd ${worktree} || echo failed; git switch main`), "blocked");
  assert.equal(verdict(`cd ${clone} || git stash`, worktree), "allowed");
  assert.equal(verdict(`pushd ${worktree}; git stash`), "blocked");
});

test("an && chain that stops early falls through to the next list in the old directory", () => {
  const missing = join(root, "missing-directory");
  assert.equal(verdict(`cd ${missing} && true; git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && true; git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && echo moved && git stash`), "allowed");
  assert.equal(verdict(`cd ${worktree} && git stash`), "allowed");
  assert.equal(verdict(`cd ${worktree} || exit 1; git stash`), "allowed");
  assert.equal(verdict(`cd ${worktree} && true || exit 1; git stash`), "allowed");
  assert.equal(verdict(`cd ${missing} && cd ${worktree}; git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && false; git stash`), "blocked");
  assert.equal(verdict(`cd ${worktree} && { echo hi; } && git stash`), "allowed");
});

test("a subshell's exit never moves the outer shell", () => {
  assert.equal(verdict(`(cd ${worktree} || exit 1); git stash`), "blocked");
  assert.equal(verdict(`(cd ${worktree} || exit 1); git stash`, worktree), "allowed");
  assert.equal(verdict(`(cd ${worktree} || exit 1) && git stash`, clone), "allowed");
  assert.equal(verdict(`cd ${worktree} || exit 1; (git stash)`), "allowed");
  assert.equal(verdict("exit 1 | cat; git stash"), "blocked");
  assert.equal(verdict("cat | exit 1; git stash"), "blocked");
  assert.equal(verdict("exit 1 & git stash"), "blocked");
  assert.equal(verdict(`cd ${worktree} || exit 1 & git stash`), "blocked");
  assert.equal(verdict(`cat | cd ${worktree} && git stash`), "blocked");
});

test("a fresh clone made in the same command may switch at once", () => {
  const fresh = join(root, "fresh");
  assert.equal(verdict(`git clone --depth 1 x ${fresh} && cd ${fresh} && git switch -c topic`), "allowed");
});

test("text that only mentions a command is judged by where it would run", () => {
  assert.equal(verdict(`cd ${clone} && python3 - <<'EOF'\nprint("git checkout -- <file>")\nEOF`), "allowed");
  assert.equal(verdict(`python3 - <<'EOF'\nprint("x")\ngit checkout -- file\nEOF`), "blocked");
});

test("the shared checkout is the one the guard lives in, whatever CLAUDE_PROJECT_DIR says", () => {
  assert.equal(verdict("git switch main", shared, { project: null }), "blocked");
  assert.equal(verdict("git switch main", root, { project: null }), "allowed");
  assert.equal(verdict(`cd ${shared} && git stash`, root, { project: null }), "blocked");
  assert.equal(verdict("git switch main", shared, { project: clone }), "blocked");
  assert.equal(verdict("git switch main", clone, { project: clone }), "allowed");
  assert.equal(verdict("git switch main", worktree, { project: root }), "allowed");
  assert.equal(verdict("git switch main", shared, { guard: linked, project: null }), "blocked");
  assert.equal(verdict("git switch main", worktree, { guard: linked, project: null }), "allowed");
});

test("a session started in a worktree still guards the shared checkout and frees its own", () => {
  assert.equal(verdict("git switch main", worktree, { guard: guardOf(worktree), project: worktree }), "allowed");
  assert.equal(verdict("git switch main", shared, { guard: guardOf(worktree), project: worktree }), "blocked");
});

test("outside any repository nothing is blocked", () => {
  assert.equal(verdict("git stash", root), "allowed");
});
