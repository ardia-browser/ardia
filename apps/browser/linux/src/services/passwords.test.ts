import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-passwords-"));
process.env.ARDIA_DATA_DIR = dataDir;
Object.defineProperty(process.versions, "chrome", { value: "140.0.0.0" });
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { safeStorage } = await import("../testing/electron.ts");
const { savedDatabase } = await import("./database.ts");
const { originalProfile } = await import("./profiles.ts");
const { allLogins, loginsFor, putLogin } = await import("./passwords.ts");

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
