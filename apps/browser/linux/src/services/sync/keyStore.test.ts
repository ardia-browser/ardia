import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { safeStorage } from "../../testing/electron.ts";

const dataDir = await mkdtemp(join(tmpdir(), "ardia-keystore-test-"));
process.env.ARDIA_DATA_DIR = dataDir;
const { deleteKey, keyPersists, loadKey, saveKey } = await import("./keyStore");

const ENTROPY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const syncFiles = () => readdir(join(dataDir, "Sync")).catch(() => [] as string[]);

beforeEach(async () => {
  await deleteKey("abc");
  await rm(join(dataDir, "Sync"), { recursive: true, force: true });
  safeStorage.backend = "basic_text";
  safeStorage.plainTextAllowed = false;
});
after(() => rm(dataDir, { recursive: true, force: true }));

for (const backend of ["basic_text", "unknown"] as const) {
  test(`without a keyring (${backend}) the sync key stays in memory and never reaches the disk`, async () => {
    safeStorage.backend = backend;
    assert.equal(keyPersists(), false);
    assert.equal(await saveKey("abc", ENTROPY), true);
    assert.deepEqual(await syncFiles(), []);
    assert.deepEqual(await loadKey("abc"), Buffer.from(ENTROPY));
    await deleteKey("abc");
    assert.equal(await loadKey("abc"), null);
  });
}

test("a key sealed with the basic key by an earlier build is deleted, not opened", async () => {
  safeStorage.plainTextAllowed = true;
  const sealed = safeStorage.encryptString(Buffer.from(ENTROPY).toString("hex")).toString("base64");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dataDir, "Sync"), { recursive: true });
  await writeFile(join(dataDir, "Sync", "sync-key-abc"), JSON.stringify({ version: 1, backend: "basic_text", sealed }));
  assert.equal(await loadKey("abc"), null);
  assert.deepEqual(await syncFiles(), []);
});

for (const backend of ["gnome_libsecret", "kwallet5"] as const) {
  test(`with a keyring (${backend}) the sync key is saved and opens at the next launch`, async () => {
    safeStorage.backend = backend;
    assert.equal(keyPersists(), true);
    assert.equal(await saveKey("abc", ENTROPY), true);
    assert.deepEqual(await syncFiles(), ["sync-key-abc"]);
    const fresh = await import(`./keyStore.ts?launch=${backend}`);
    assert.deepEqual(await fresh.loadKey("abc"), Buffer.from(ENTROPY));
  });
}
