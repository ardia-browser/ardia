import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("./ardia-launch", import.meta.url));
const AS_ROOT = process.geteuid() === 0;
const HANDS_OVER = { skip: AS_ROOT && "root never hands over" };

function executable(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function launch(t, args, { command = "data", env = {}, folder = null, installed = "script", status = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ardia-launch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "lib/ardia");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "ardia-launch"), readFileSync(LAUNCHER, "utf8").replaceAll("/proc/sys/", `${root}/proc/sys/`));
  chmodSync(join(runtime, "ardia-launch"), 0o755);
  executable(join(runtime, "chrome"), 'printf "browser %s\\n" "$@"');
  const homes = { data: join(root, "data/ardia/cli"), own: join(root, "own"), home: join(root, "home/.local/share/ardia/cli") };
  if (command) {
    const installedCommand = join(homes[command], "9.9.9/bin/ardia");
    if (installed === "folder") mkdirSync(installedCommand, { recursive: true });
    else executable(installedCommand, 'printf "command %s\\n" "$@"\n[[ "$1" == fail ]] && exit 3\nexit 0');
    if (installed === "unexecutable") chmodSync(installedCommand, 0o644);
    symlinkSync("9.9.9", join(homes[command], "current"));
  }
  writeFileSync(join(root, "page"), "");
  if (folder) mkdirSync(join(root, folder));
  const variables = { PATH: process.env.PATH, XDG_DATA_HOME: join(root, "data"), HOME: join(root, "home"), ...env };
  if (variables.ARDIA_CLI_HOME) variables.ARDIA_CLI_HOME = join(root, variables.ARDIA_CLI_HOME);
  const result = spawnSync(join(runtime, "ardia-launch"), args, { cwd: root, env: variables, encoding: "utf8" });
  assert.equal(result.status, status, result.stderr);
  return result.stdout.trimEnd().split("\n");
}

test("a command word reaches the installed ardia command, which this launcher shadows when it comes first on PATH", HANDS_OVER, (t) => {
  assert.deepEqual(launch(t, ["browse", "open", "https://example.com"]), ["command browse", "command open", "command https://example.com"]);
});

test("the command is found where its installer puts it", HANDS_OVER, (t) => {
  assert.deepEqual(launch(t, ["tabs"], { command: "own", env: { ARDIA_CLI_HOME: "own" } }), ["command tabs"]);
  assert.deepEqual(launch(t, ["notes"], { command: "home", env: { XDG_DATA_HOME: "relative" } }), ["command notes"]);
});

test("hosts, URLs, switches and files still open in the browser", (t) => {
  for (const argument of ["example.com", "https://example.com", "localhost:3000", "--new-window", "--version", "page"]) {
    assert.deepEqual(launch(t, [argument]), [`browser ${argument}`], argument);
  }
  assert.deepEqual(launch(t, []), ["browser"]);
});

test("without the command installed a word opens in the browser as before", (t) => {
  assert.deepEqual(launch(t, ["browse"], { command: null }), ["browser browse"]);
});

test("a folder named like a command doesn't stop the command, but a file does", HANDS_OVER, (t) => {
  assert.deepEqual(launch(t, ["scripts", "list"], { folder: "scripts" }), ["command scripts", "command list"]);
  assert.deepEqual(launch(t, ["page"]), ["browser page"]);
});

test("the command's exit status comes back", HANDS_OVER, (t) => {
  assert.deepEqual(launch(t, ["fail"], { status: 3 }), ["command fail"]);
});

test("only ASCII command words reach the command, whatever the locale", HANDS_OVER, async (t) => {
  for (const locale of ["C", "C.UTF-8", "en_US.UTF-8"]) {
    const installed = spawnSync("bash", ["-c", ":"], { env: { PATH: process.env.PATH, LC_ALL: locale }, encoding: "utf8" }).stderr === "";
    await t.test(locale, { skip: !installed && `${locale} isn't installed here` }, (st) => {
      assert.deepEqual(launch(st, ["café"], { env: { LC_ALL: locale } }), ["browser café"]);
      assert.deepEqual(launch(st, ["tabs"], { env: { LC_ALL: locale } }), ["command tabs"]);
    });
  }
});

test("a command that isn't a runnable file leaves the word to the browser", (t) => {
  assert.deepEqual(launch(t, ["tabs"], { installed: "folder" }), ["browser tabs"]);
  assert.deepEqual(launch(t, ["tabs"], { installed: "unexecutable" }), ["browser tabs"]);
});

test("as root a command word stays in the browser", { skip: !AS_ROOT && "runs only as root" }, (t) => {
  assert.deepEqual(launch(t, ["tabs"]), ["browser tabs"]);
});
