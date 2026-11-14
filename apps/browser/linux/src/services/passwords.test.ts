import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { CORRECT_PASSWORD, scriptedPrompt, stubPasswordHelper, untilHelperRuns } from "../testing/ownerCheck.ts";

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

const { dialog, safeStorage } = await import("../testing/electron.ts");
const { savedDatabase } = await import("./database.ts");
const { originalProfile } = await import("./profiles.ts");
const { allLogins, loginsFor, passwordVerbs, putLogin } = await import("./passwords.ts");
const { ownerWentAway, presentOwnerPromptsWith, revokeOwnerGrant } = await import("../ownerCheck.ts");

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

test("an unlock whose password check finishes after the owner went away stays locked", async () => {
  putLogin("", "https://late.example/", "me", "pw-late", true);
  helper.setMode("slow");
  try {
    const before = helper.calls();
    prompt.answers.push(CORRECT_PASSWORD);
    const unlocking = passwordVerbs.unlock!({}, "");
    await untilHelperRuns(helper, before);
    ownerWentAway();
    assert.deepEqual(await unlocking, { unlocked: false });
    assert.throws(() => passwordVerbs.reveal!({ origin: "https://late.example", username: "me" }, ""), /locked/);
  } finally {
    helper.setMode("check");
  }
});

async function exportingWithSaveDialog(choose: (path: string) => Promise<{ canceled: boolean; filePath?: string }>) {
  const path = join(dataDir, `export-${Math.random().toString(36).slice(2)}.csv`);
  const showSaveDialog = dialog.showSaveDialog;
  delete process.env.ARDIA_BACKGROUND;
  dialog.showSaveDialog = () => choose(path);
  try {
    return { path, result: await passwordVerbs.export!({}, "") };
  } finally {
    dialog.showSaveDialog = showSaveDialog;
    process.env.ARDIA_BACKGROUND = "1";
  }
}

test("going away while the export's save dialog is open cancels the export before a password is opened", async () => {
  putLogin("", "https://export.example/", "me", "pw-export", true);
  const decrypts = mock.method(safeStorage, "decryptString");
  try {
    prompt.answers.push(CORRECT_PASSWORD);
    const { path, result } = await exportingWithSaveDialog(async (path) => {
      ownerWentAway();
      return { canceled: false, filePath: path };
    });
    assert.deepEqual(result, { status: "cancelled" });
    assert.equal(existsSync(path), false);
    assert.equal(decrypts.mock.callCount(), 0);
  } finally {
    decrypts.mock.restore();
  }
});

test("a save dialog that outlives the grant makes the export ask again before it writes", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    prompt.answers.push(CORRECT_PASSWORD, null);
    const { path, result } = await exportingWithSaveDialog(async (path) => {
      mock.timers.tick(2 * 60_000);
      return { canceled: false, filePath: path };
    });
    assert.deepEqual(result, { status: "cancelled" });
    assert.equal(existsSync(path), false);
    assert.deepEqual(prompt.asked, ["export your saved passwords", "export your saved passwords"]);
  } finally {
    mock.timers.reset();
  }
});

test("an export the owner stays for writes the file", async () => {
  prompt.answers.push(CORRECT_PASSWORD);
  const { path, result } = await exportingWithSaveDialog(async (path) => ({ canceled: false, filePath: path }));
  assert.deepEqual(result, { status: "succeeded", path });
  assert.match(readFileSync(path, "utf8"), /pw-export/);
});
