import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SyncKeys } from "./crypto.ts";
import { hidePasswords, restorePasswords } from "./logins.ts";
import { entropyFrom, wordsFor } from "./phrase.ts";
import { qrCode } from "./qr.ts";
import { SyncVault } from "./vault.ts";

const FIXTURES = join(fileURLToPath(import.meta.url), "../../../../../../../packages/sync/tests/fixtures/windows-interop");

type Manifest = {
  entropy: string;
  words: string[];
  chainTag: string;
  scopeTags: Record<string, string>;
  files: { scope: string; id: string; payload: string }[];
  local: { plain: string; sealed: string };
  password: { origin: string; username: string; password: string; sealed: string };
};

const manifest = async (side: "mac" | "windows") => JSON.parse(await readFile(join(FIXTURES, `${side}.json`), "utf8")) as Manifest;
const SIDES = ["mac", "windows"] as const;

const subtle = globalThis.crypto.subtle;
const utf8 = (text: string) => Uint8Array.from(new TextEncoder().encode(text));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

async function referenceKeys(entropy: Uint8Array) {
  const ikm = await subtle.importKey("raw", Uint8Array.from(entropy), "HKDF", false, ["deriveBits"]);
  const derive = async (info: string) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("netnyahoo-sync/v1"), info: utf8(info) }, ikm, 256));
  const nameKey = await subtle.importKey("raw", await derive("name-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const tag = async (label: string) => {
    const mac = new Uint8Array(await subtle.sign("HMAC", nameKey, utf8(label))).slice(0, 16);
    let bits = "";
    for (const byte of mac) bits += byte.toString(2).padStart(8, "0");
    bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
    return bits.match(/.{5}/g)!.map((chunk) => alphabet[parseInt(chunk, 2)]).join("");
  };
  const fileKey = await subtle.importKey("raw", await derive("file-key"), "AES-GCM", false, ["decrypt"]);
  const passwordKey = await subtle.importKey("raw", await derive("password-key"), "AES-GCM", false, ["decrypt"]);
  const chainTag = await tag("chain");
  const unpad = (plain: Uint8Array) => {
    const length = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
    return plain.slice(4, 4 + length);
  };
  return {
    chainTag,
    tag,
    async openFile(file: Uint8Array, scopeTag: string, id: string) {
      assert.equal(new TextDecoder().decode(file.slice(0, 4)), "NNS1");
      const aad = utf8(`NNS1${chainTag}/${scopeTag}/${id}`);
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: file.slice(4, 16), additionalData: aad, tagLength: 128 }, fileKey, file.slice(16)));
      assert.equal(plain.length % 1024, 0);
      return new TextDecoder().decode(unpad(plain));
    },
    async openPassword(sealed: string, origin: string, username: string) {
      const data = Uint8Array.from(Buffer.from(sealed, "base64"));
      assert.equal(data[0], 1);
      const originBytes = utf8(origin);
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, originBytes.length);
      const aad = concat(utf8("NNS1password/"), length, originBytes, utf8(username));
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: data.slice(1, 13), additionalData: aad, tagLength: 128 }, passwordKey, data.slice(13)));
      return new TextDecoder().decode(unpad(plain));
    },
  };
}

test("keys, tags and the recovery phrase match the Mac and Windows", async () => {
  for (const side of SIDES) {
    const m = await manifest(side);
    const entropy = Buffer.from(m.entropy, "hex");
    const keys = new SyncKeys(entropy);
    assert.equal(keys.chainTag, m.chainTag);
    for (const [scope, tag] of Object.entries(m.scopeTags)) assert.equal(keys.scopeTag(scope), tag);
    assert.deepEqual(wordsFor(entropy), m.words);
    assert.deepEqual(entropyFrom(m.words.join(" ")), entropy);
    assert.deepEqual(entropyFrom(`  ${m.words.map((w, i) => (i % 2 ? w.toUpperCase() : w.slice(0, Math.max(4, w.length - 1)))).join(",\n")} `), entropy);
  }
});

test("phrase problems are reported like the Mac", () => {
  const words = wordsFor(Buffer.alloc(32, 7));
  assert.deepEqual(entropyFrom(words.slice(1).join(" ")), { error: "wordCount", count: 23 });
  assert.deepEqual(entropyFrom(["zzzz", ...words.slice(1)].join(" ")), { error: "unknownWord", word: "zzzz" });
  assert.deepEqual(entropyFrom([...words.slice(0, 23), words[23] === "abandon" ? "ability" : "abandon"].join(" ")), { error: "checksum" });
});

test("Linux opens the vaults the Mac and Windows wrote", async () => {
  for (const side of SIDES) {
    const m = await manifest(side);
    const keys = new SyncKeys(Buffer.from(m.entropy, "hex"));
    const vault = new SyncVault(join(FIXTURES, side), keys);
    assert.equal(await vault.chainStatus(), "ok");
    for (const file of m.files) {
      const listing = await vault.read(file.scope, []);
      assert.deepEqual(listing.damaged, [], `${side} ${file.scope}`);
      assert.deepEqual(listing.present, [file.id]);
      const payload = listing.files[0]!.payload;
      assert.ok(!payload.includes("correct horse"), "passwords stay sealed on their way to the UI");
      assert.deepEqual(JSON.parse(restorePasswords(payload, keys)), JSON.parse(file.payload));
      assert.deepEqual(await vault.read(file.scope, [file.id]), { files: [], pending: [], damaged: [], present: [file.id] });
    }
    assert.equal(keys.open(Buffer.from(m.local.sealed, "base64"), "local", "state").toString("utf8"), m.local.plain);
    assert.equal(keys.openPassword(m.password.sealed, m.password.origin, m.password.username), m.password.password);
  }
});

test("passwords seal byte for byte like the Mac and Windows", async () => {
  for (const side of SIDES) {
    const m = await manifest(side);
    const keys = new SyncKeys(Buffer.from(m.entropy, "hex"));
    assert.equal(keys.sealPassword(m.password.password, m.password.origin, m.password.username), m.password.sealed);
  }
});

test("what Linux writes opens with an independent implementation of the format", async () => {
  const m = await manifest("windows");
  const entropy = Buffer.from(m.entropy, "hex");
  const keys = new SyncKeys(entropy);
  const reference = await referenceKeys(entropy);
  assert.equal(reference.chainTag, m.chainTag);
  for (const side of SIDES) {
    for (const file of (await manifest(side)).files) {
      const sealed = await readFile(join(FIXTURES, side, m.chainTag, m.scopeTags[file.scope]!, `${file.id}.nns`));
      assert.equal(await reference.openFile(sealed, m.scopeTags[file.scope]!, file.id), file.payload);
    }
  }

  const folder = await mkdtemp(join(tmpdir(), "ardia-sync-test-"));
  try {
    const vault = new SyncVault(folder, keys);
    assert.equal(await vault.chainStatus(), "missing");
    await vault.createChain();
    assert.equal(await vault.chainStatus(), "ok");
    for (const file of m.files) {
      const hidden = hidePasswords(file.payload, keys)!;
      const id = await vault.write(file.scope, hidden);
      const scopeTag = await reference.tag(`scope/${file.scope}`);
      const written = await readFile(join(folder, reference.chainTag, scopeTag, `${id}.nns`));
      assert.deepEqual(JSON.parse(await reference.openFile(written, scopeTag, id)), JSON.parse(file.payload));
    }
    const sealedLocal = keys.seal(Buffer.from(m.local.plain), "local", "state");
    assert.equal(await reference.openFile(sealedLocal, "local", "state"), m.local.plain);
    const sealedPassword = keys.sealPassword("pässwörd ✓", "https://ardia.dev", "nathan");
    assert.equal(await reference.openPassword(sealedPassword, "https://ardia.dev", "nathan"), "pässwörd ✓");

    const scope = m.files[0]!.scope;
    const ids = (await vault.read(scope, [])).present;
    assert.equal(ids.length, 1);
    await vault.remove(scope, ids);
    assert.deepEqual((await vault.read(scope, [])).present, []);
    await vault.deleteChain();
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("damaged and foreign files are reported, not thrown", async () => {
  const m = await manifest("mac");
  const folder = await mkdtemp(join(tmpdir(), "ardia-sync-test-"));
  try {
    const keys = new SyncKeys(Buffer.from(m.entropy, "hex"));
    const other = new SyncKeys(Buffer.alloc(32, 9));
    const vault = new SyncVault(folder, keys);
    await vault.createChain();
    const good = await vault.write("app", '{"a":1}');
    const scopeDir = vault.scopePath("app");
    const { writeFile } = await import("node:fs/promises");
    const bad = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    await writeFile(join(scopeDir, `${bad}.nns`), other.seal(Buffer.from("{}"), keys.scopeTag("app"), bad));
    await writeFile(join(scopeDir, "notes.txt"), "hello");
    const listing = await vault.read("app", [], Date.now() + 1000);
    assert.deepEqual(listing.files, [{ id: good, payload: '{"a":1}' }]);
    assert.deepEqual(listing.damaged.map((d) => d.id), [bad]);
    assert.ok(listing.damaged[0]!.age >= 1000);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the recovery QR code matches the Mac's", async () => {
  const m = await manifest("mac");
  const expected = (await readFile(join(FIXTURES, "qr.txt"), "utf8")).trimEnd().split("\n");
  const code = qrCode(m.words.join(" "));
  const rows: string[] = [];
  for (let y = -1; y <= code.size; y++) {
    let row = "";
    for (let x = -1; x <= code.size; x++) row += x >= 0 && y >= 0 && x < code.size && y < code.size && code.dark(x, y) ? "1" : "0";
    rows.push(row);
  }
  assert.deepEqual(rows, expected);
});
