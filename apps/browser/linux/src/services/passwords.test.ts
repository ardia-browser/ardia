import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { CORRECT_PASSWORD, scriptedPrompt, stubPasswordHelper } from "../testing/ownerCheck.ts";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-passwords-"));
const helper = stubPasswordHelper();
process.env.ARDIA_DATA_DIR = dataDir;
process.env.ARDIA_TEST = `passwordHelper=${helper.path}`;
process.env.ARDIA_BACKGROUND = "1";
Object.defineProperty(process.versions, "chrome", { value: "140.0.0.0" });
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  helper.remove();
});

const { safeStorage } = await import("../testing/electron.ts");
const { savedDatabase } = await import("./database.ts");
const { originalProfile } = await import("./profiles.ts");
const { allLogins, loginsFor, passwordVerbs, putLogin } = await import("./passwords.ts");
const { presentOwnerPromptsWith, revokeOwnerGrant } = await import("../ownerCheck.ts");

let prompt = scriptedPrompt();
beforeEach(() => {
  revokeOwnerGrant();
  prompt = scriptedPrompt();
  presentOwnerPromptsWith(prompt.ui);
});

const prefixOf = (origin: string) =>
  Buffer.from((savedDatabase(originalProfile("")).prepare("SELECT password FROM logins WHERE origin = ?").get(origin) as { password: Uint8Array }).password.subarray(0, 3)).toString();

test("without a keyring passwords seal with Chrome's basic backend and still open", () => {
  safeStorage.backend = "basic_text";
  safeStorage.plainTextAllowed = false;
  putLogin("", "https://a.example/login", "me", "pw-a", false);
  assert.equal(prefixOf("https://a.example"), "v10");
  assert.deepEqual(loginsFor("", "https://a.example").map((login) => login.password), ["pw-a"]);
});

test("passwords sealed without a keyring move to the keyring when they're next read", () => {
  safeStorage.backend = "gnome_libsecret";
  assert.equal(prefixOf("https://a.example"), "v10");
  assert.deepEqual(allLogins("").map((login) => login.password), ["pw-a"]);
  assert.equal(prefixOf("https://a.example"), "v11");
  assert.deepEqual(loginsFor("", "https://a.example").map((login) => login.password), ["pw-a"]);
});

test("exporting asks for the login password before it opens a single password", async () => {
  putLogin("", "https://export.example/", "me", "pw-export", true);
  const decrypts = mock.method(safeStorage, "decryptString");
  try {
    prompt.answers.push(null);
    assert.deepEqual(await passwordVerbs.export!({}, ""), { status: "cancelled" });
    assert.deepEqual(prompt.asked, ["export your saved passwords"]);
    assert.equal(decrypts.mock.callCount(), 0);
  } finally {
    decrypts.mock.restore();
  }
});

test("exporting right after an unlock uses the live grant instead of asking again", async () => {
  prompt.answers.push(CORRECT_PASSWORD);
  assert.deepEqual(await passwordVerbs.unlock!({}, ""), { unlocked: true });
  assert.deepEqual(await passwordVerbs.export!({}, ""), { status: "cancelled" });
  assert.deepEqual(prompt.asked, ["show your saved passwords"]);
});

test("revealing a password needs an unlock in the main process, which lasts five minutes", async () => {
  putLogin("", "https://reveal.example/", "me", "pw-reveal", true);
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 10 * 60_000 });
  try {
    const reveal = () => passwordVerbs.reveal!({ origin: "https://reveal.example", username: "me" }, "");
    assert.throws(reveal, /locked/);
    prompt.answers.push(null);
    assert.deepEqual(await passwordVerbs.unlock!({}, ""), { unlocked: false });
    assert.throws(reveal, /locked/);
    prompt.answers.push(CORRECT_PASSWORD);
    assert.deepEqual(await passwordVerbs.unlock!({}, ""), { unlocked: true });
    assert.deepEqual(reveal(), { password: "pw-reveal" });
    mock.timers.tick(5 * 60_000);
    assert.throws(reveal, /locked/);
  } finally {
    mock.timers.reset();
  }
});
