import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { CORRECT_PASSWORD, scriptedPrompt, stubPasswordHelper } from "./testing/ownerCheck.ts";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-owner-"));
const helper = stubPasswordHelper();
process.env.ARDIA_DATA_DIR = dataDir;
process.env.ARDIA_TEST = `passwordHelper=${helper.path}`;
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  helper.remove();
});

const { confirmDeviceOwner, presentOwnerPromptsWith, revokeOwnerGrant } = await import("./ownerCheck.ts");

let prompt = scriptedPrompt();
beforeEach(() => {
  revokeOwnerGrant();
  helper.setMode("check");
  prompt = scriptedPrompt();
  presentOwnerPromptsWith(prompt.ui);
});

test("the right login password grants, after a wrong one is refused", async () => {
  prompt.answers.push("wrong", CORRECT_PASSWORD);
  assert.equal(await confirmDeviceOwner("show your saved passwords"), true);
  assert.deepEqual(prompt.asked, ["show your saved passwords"]);
  assert.deepEqual(prompt.refusals, ["wrong"]);
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
