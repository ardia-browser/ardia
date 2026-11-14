import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-keychain-"));
process.env.ARDIA_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { safeStorage } = await import("../testing/electron.ts");
const { flushDocuments } = await import("./documents.ts");
type Keychain = typeof import("./keychain.ts");
let instance = 0;
const freshKeychain = async () => (await import(`./keychain.ts?instance=${++instance}`)) as Keychain;
const SECRETS = join(dataDir, "Secrets.json");
const onDisk = () => JSON.parse(readFileSync(SECRETS, "utf8")) as Record<string, { backend: string; sealed: boolean; value: string }>;
async function landed(account: string, backend: string) {
  for (const until = Date.now() + 2000; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 5))) {
    try {
      if (onDisk()[account]?.backend === backend) return;
    } catch {}
  }
  assert.fail(`${account} never landed sealed with ${backend}`);
}

beforeEach(() => {
  safeStorage.backend = "basic_text";
  safeStorage.plainTextAllowed = false;
  rmSync(SECRETS, { force: true });
});

test("without a keyring a secret is sealed with Chrome's basic backend, never stored as plain base64", async () => {
  const keychain = await freshKeychain();
  assert.equal(await keychain.set("sync", "hunter2"), true);
  await landed("sync", "basic_text");
  const stored = onDisk().sync!;
  assert.notEqual(Buffer.from(stored.value, "base64").toString("utf8"), "hunter2", "the secret is on disk in the clear");
  assert.equal(stored.sealed, true);
  assert.equal(stored.backend, "basic_text");
  assert.ok(Buffer.from(stored.value, "base64").subarray(0, 3).toString() === "v10");
  assert.equal(await keychain.get("sync"), "hunter2");
});

test("a secret stored as plain base64 by an older build is sealed when the keychain loads", async () => {
  writeFileSync(SECRETS, JSON.stringify({ old: { backend: "none", sealed: false, value: Buffer.from("legacy").toString("base64") } }));
  const keychain = await freshKeychain();
  assert.equal(await keychain.get("old"), "legacy");
  await landed("old", "basic_text");
  const stored = onDisk().old!;
  assert.equal(stored.sealed, true);
  assert.equal(stored.backend, "basic_text");
});

test("secrets sealed without a keyring move to the keyring once there is one", async () => {
  const before = await freshKeychain();
  await before.set("sync", "hunter2");
  await landed("sync", "basic_text");
  safeStorage.backend = "gnome_libsecret";
  const keychain = await freshKeychain();
  assert.equal(await keychain.get("sync"), "hunter2");
  await landed("sync", "gnome_libsecret");
  const stored = onDisk().sync!;
  assert.equal(Buffer.from(stored.value, "base64").subarray(0, 3).toString(), "v11");
  assert.equal(await keychain.get("sync"), "hunter2");
});

test("the protection in use is readable: keyring or basic", async () => {
  const keychain = await freshKeychain();
  assert.deepEqual(await keychain.protection(), { backend: "basic_text", keyring: false });
  safeStorage.backend = "kwallet6";
  assert.deepEqual(await keychain.protection(), { backend: "kwallet6", keyring: true });
});

after(() => void flushDocuments());
