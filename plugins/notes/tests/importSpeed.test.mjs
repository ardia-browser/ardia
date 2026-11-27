import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { load } from "./support/build.mjs";

const M = await load();
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const hexOf = (bytes) => Buffer.from(bytes).toString("hex");
const SIZES = [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 4095, 4096, 4097, 65_537, (1 << 20) + 77, (2 << 20) + 3];

test("sha256 matches node's for every length, in one update or many, through wasm and through script", () => {
  assert.ok(M.wasmCompressor(), "node runs the generated wasm module");
  for (const script of [false, true]) {
    M.preferScriptSha256(script);
    for (const n of SIZES) {
      const data = new Uint8Array(randomBytes(n));
      const want = createHash("sha256").update(data).digest("hex");
      assert.equal(hexOf(new M.Sha256().update(data).digest()), want, `${n} bytes in one update (${script ? "script" : "wasm"})`);
      const pieces = new M.Sha256();
      for (let at = 0; at < n; at += 5003) pieces.update(data.subarray(at, at + 5003));
      assert.equal(hexOf(pieces.digest()), want, `${n} bytes in pieces (${script ? "script" : "wasm"})`);
    }
  }
  M.preferScriptSha256(false);
});

test("the generated sha256 wasm module is valid and small", () => {
  const bytes = M.sha256Module();
  assert.ok(WebAssembly.validate(bytes));
  assert.ok(bytes.length < 16_384, `${bytes.length} bytes`);
});

test("base64 round-trips through the native and script encoders and the strict and loose decoders", () => {
  for (const n of [0, 1, 2, 3, 4, 63, 64, 65, 66, 24_570, 24_571, 100_003]) {
    const data = new Uint8Array(randomBytes(n));
    const text = Buffer.from(data).toString("base64");
    assert.equal(M.bytes.toBase64(data), text, `encodes ${n} bytes`);
    assert.deepEqual(Buffer.from(M.bytes.fromBase64(text)), Buffer.from(data), `decodes ${n} bytes`);
    assert.deepEqual(Buffer.from(M.bytes.fromBase64(Buffer.from(data).toString("base64url"))), Buffer.from(data), `decodes url-safe ${n} bytes`);
    assert.deepEqual(Buffer.from(M.bytes.fromBase64(text.replace(/(.{76})/g, "$1\n"))), Buffer.from(data), `decodes wrapped ${n} bytes`);
  }
  assert.throws(() => M.bytes.fromBase64("ab$d"), /valid base64/);
  assert.throws(() => M.bytes.fromBase64("abcĀ"), /valid base64/);
});

test("crc32 matches zlib's for every tail length", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 1000, 100_003]) {
    const data = randomBytes(n);
    assert.equal(M.bytes.crc32(new Uint8Array(data)), zlibCrc32(data), `${n} bytes`);
  }
});

test("the import file writer answers with the hash at once, keeps at most its budget in flight, and drains", async () => {
  const saves = [];
  const writer = new M.FileWriter((data) => {
    let done;
    const saved = new Promise((resolve) => (done = resolve));
    saves.push({ size: data.length, done });
    return { sha: `sha${saves.length}`, saved };
  }, 10);
  assert.equal(await writer.put(new Uint8Array(4), "bin"), "sha1");
  assert.equal(await writer.put(new Uint8Array(4), "bin"), "sha2");
  assert.equal(writer.inFlightBytes, 8);
  let third = false;
  const next = writer.put(new Uint8Array(4), "bin").then((sha) => ((third = true), sha));
  for (let tick = 0; tick < 5; tick++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(third, false, "a write over the budget waits for one in flight");
  saves[0].done();
  assert.equal(await next, "sha3");
  assert.ok(writer.inFlightBytes <= 10);
  saves[1].done();
  saves[2].done();
  await writer.drain();
  assert.equal(writer.inFlightBytes, 0);
});

test("the import file writer reports a failed save at the next put or drain", async () => {
  const writer = new M.FileWriter(() => ({ sha: "x", saved: Promise.reject(new Error("disk full")) }), 1);
  await writer.put(new Uint8Array(1), "bin");
  await assert.rejects(writer.drain(), /disk full/);
  await assert.rejects(writer.put(new Uint8Array(1), "bin"), /disk full/);
});

test("read-ahead reads each wanted key once, within its byte and count budget, and keeps only what's still wanted", async () => {
  const reads = [];
  const ahead = new M.ReadAhead(
    async (key) => {
      reads.push(key);
      if (key === "bad") throw new Error("gone");
      return new Uint8Array([key.length]);
    },
    (key) => (key === "big" ? 100 : 1),
    10,
    3,
  );
  ahead.want(["a", "b", "big", "c", "d"]);
  assert.deepEqual(reads, ["a", "b"], "the budget stops at the first key that doesn't fit");
  assert.deepEqual([...(await ahead.take("a"))], [1]);
  assert.equal(ahead.has("a"), false);
  await ahead.take("a");
  assert.deepEqual(reads, ["a", "b", "a"], "a key taken twice is read again");
  ahead.keep(["c", "bad"]);
  assert.equal(ahead.has("b"), false, "keep drops keys no longer wanted");
  assert.ok(ahead.has("c") && ahead.has("bad"));
  await assert.rejects(ahead.take("bad"), /gone/);
  assert.equal(ahead.queuedBytes, 1);
});

test("putFile hashes once and doesn't read a new file back; an existing file of the right size is kept, a damaged one is rewritten", async () => {
  const data = mkdtempSync(join(tmpdir(), "notes-putfile-"));
  const files = M.nodeFiles({ data });
  cleanups.push(() => files.detach());
  const storage = new Map();
  const hub = M.pageHub();
  const notes = new M.Notes({ files, folders: M.fakeFolders(files, join(data, "..", "putfile-shared")), storage: { get: async (k) => structuredClone(storage.get(k)), set: async (k, v) => void storage.set(k, structuredClone(v)) }, setting: () => "", post: hub.post, openPage: async () => {}, openUrl: async () => {}, store: { debounceMs: 20, rescanMs: 60_000 } });
  hub.attach(notes);
  cleanups.push(() => notes.stop());
  await notes.start();
  const store = notes.spaces.get(notes.workspaces()[0].id).store;
  const fileReads = [];
  const fileWrites = [];
  const read = files.read.bind(files);
  const write = files.write.bind(files);
  files.read = (path, options) => {
    if (path.includes("/files/") || path.startsWith("files/")) fileReads.push({ path, length: options?.length });
    return read(path, options);
  };
  files.write = (path, text, options) => {
    if (path.includes("/files/") || path.startsWith("files/")) fileWrites.push({ path, options });
    return write(path, text, options);
  };
  const small = new Uint8Array(randomBytes(5000));
  const sha = await store.putFile(small, "png");
  assert.equal(sha, createHash("sha256").update(small).digest("hex"));
  assert.equal(fileReads.filter((r) => r.length !== 0).length, 0, "the new file isn't read back");
  assert.equal(fileWrites.length, 1);
  const saved = fileWrites[0];
  fileWrites.length = 0;
  assert.equal(await store.putFile(small, "png"), sha);
  assert.equal(fileWrites.length, 0, "the same bytes again are kept");
  const big = new Uint8Array(randomBytes(4 * 1024 * 1024 + 4097));
  const bigSha = await store.putFile(big, "mp4");
  assert.equal(bigSha, createHash("sha256").update(big).digest("hex"));
  assert.ok(await store.hasFile(bigSha, big.length));
  assert.deepEqual(Buffer.from((await store.getFile(bigSha)).data), Buffer.from(big));
  await write(saved.path, Buffer.from(small.subarray(0, 10)).toString("base64"), { root: saved.options?.root });
  assert.equal(await store.hasFile(sha, small.length), false, "a file cut short isn't counted as there");
  fileWrites.length = 0;
  assert.equal(await store.putFile(small, "png"), sha);
  assert.equal(fileWrites.length, 1, "a damaged file is written again");
  assert.deepEqual(Buffer.from((await store.getFile(sha)).data), Buffer.from(small));
});
