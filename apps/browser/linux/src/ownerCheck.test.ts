import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { CORRECT_PASSWORD, scriptedPrompt, stubPasswordHelper } from "./testing/ownerCheck.ts";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-owner-"));
const helper = stubPasswordHelper();
process.env.ARDIA_DATA_DIR = dataDir;
process.env.ARDIA_TEST = `passwordHelper=${helper.path}`;
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  helper.remove();
});

const { confirmDeviceOwner, presentOwnerPromptsWith, revokeOwnerGrant, runPasswordHelper, trustedPasswordHelper } = await import("./ownerCheck.ts");

let prompt = scriptedPrompt();
beforeEach(() => {
  revokeOwnerGrant();
  helper.setMode("check");
  prompt = scriptedPrompt();
  presentOwnerPromptsWith(prompt.ui);
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
});
afterEach(() => mock.timers.reset());

test("the right login password grants, after a wrong one is refused", async () => {
  prompt.answers.push("wrong", CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
  assert.deepEqual(prompt.asked, ["show your saved passwords"]);
  assert.deepEqual(prompt.refusals, [["Wrong password.", 0]]);
  assert.equal(prompt.closed, 1);
});

test("a grant counts for the next check without asking again", async () => {
  prompt.answers.push(CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
  assert.equal(await confirmDeviceOwner("export your saved passwords"), true);
  assert.equal(prompt.asked.length, 1);
});

test("cancelling denies", async () => {
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
});

test("a background instance still asks, and a cancel denies", async () => {
  process.env.ARDIA_BACKGROUND = "1";
  try {
    prompt.answers.push(null);
    assert.equal(await confirmDeviceOwner("show your sync recovery phrase"), false);
    assert.deepEqual(prompt.asked, ["show your sync recovery phrase"]);
  } finally {
    delete process.env.ARDIA_BACKGROUND;
  }
});

test("with no password helper the check is denied and says why, without asking", async () => {
  helper.hide();
  try {
    assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
    assert.deepEqual(prompt.unavailable, ["show your saved passwords"]);
    assert.deepEqual(prompt.asked, []);
  } finally {
    helper.restore();
  }
});

test("only a root-owned helper in root-owned folders nobody else can write is trusted", { skip: !existsSync("/usr/sbin/unix_chkpwd") }, () => {
  assert.equal(trustedPasswordHelper(helper.path), null);
  assert.equal(trustedPasswordHelper(join(dataDir, "missing")), null);
  assert.equal(trustedPasswordHelper("/usr/sbin/unix_chkpwd"), "/usr/sbin/unix_chkpwd");
});

test("wrong passwords wait longer and longer, even across prompts, until the right one", async () => {
  const before = helper.calls();
  prompt.answers.push("w1", "w2", "w3", CORRECT_PASSWORD, null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.refusals, [
    ["Wrong password.", 0],
    ["Wrong password.", 0],
    ["Wrong password.", 2_000],
    ["", 2_000],
  ]);
  assert.equal(helper.calls() - before, 3);

  mock.timers.tick(500);
  prompt.answers.push(null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.openedWaiting, [0, 1_500]);

  mock.timers.tick(1_500);
  prompt.answers.push("w4", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  mock.timers.tick(5_000);
  prompt.answers.push("w5", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  mock.timers.tick(30_000);
  prompt.answers.push("w6", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  mock.timers.tick(60_000);
  prompt.answers.push("w7", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.refusals.slice(4), [
    ["Wrong password.", 5_000],
    ["Wrong password.", 30_000],
    ["Wrong password.", 60_000],
    ["Wrong password.", 60_000],
  ]);

  mock.timers.tick(60_000);
  prompt.answers.push(CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
  revokeOwnerGrant();
  prompt.answers.push("w8", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.refusals.at(-1), ["Wrong password.", 0]);
  prompt.answers.push(CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
});

test("a helper that crashes is reported as such, not as a wrong password", async () => {
  helper.setMode("crash");
  prompt.answers.push(CORRECT_PASSWORD, "again", "and again", null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.refusals, [
    ["Ardia couldn't check the password.", 0],
    ["Ardia couldn't check the password.", 0],
    ["Ardia couldn't check the password.", 0],
  ]);
});

test("a helper that hangs past its deadline, or can't start, fails rather than refusing the password", async () => {
  mock.timers.reset();
  helper.setMode("hang");
  assert.equal(await runPasswordHelper(helper.path, CORRECT_PASSWORD, 300), "failed");
  assert.equal(await runPasswordHelper(join(dataDir, "missing"), CORRECT_PASSWORD), "failed");
  helper.setMode("check");
  assert.equal(await runPasswordHelper(helper.path, "wrong"), "mismatch");
  assert.equal(await runPasswordHelper(helper.path, CORRECT_PASSWORD), "match");
});

test("passwords over 512 bytes or holding NUL never reach the helper", async () => {
  const before = helper.calls();
  prompt.answers.push("é".repeat(257), "pass\0word", "x".repeat(512), null);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), false);
  assert.deepEqual(prompt.refusals, [
    ["That password is too long to check.", 0],
    ["That password can't be checked.", 0],
    ["Wrong password.", 0],
  ]);
  assert.equal(helper.calls() - before, 1);
  prompt.answers.push(CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
});
