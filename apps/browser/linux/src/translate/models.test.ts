import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { net } from "electron";

const STORE = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/";
const scratch = mkdtempSync(join(tmpdir(), "ardia-translate-models-"));
const folder = join(scratch, "Translations");
const pairFolder = join(folder, "fr-en");
process.env.ARDIA_DATA_DIR = scratch;

const contents = { model: Buffer.alloc(300_000, 7), lex: Buffer.from("lexical shortlist ".repeat(2_000)), vocab: Buffer.from("vocabulary ".repeat(1_000)) };
type Part = keyof typeof contents;
const pathOf = (type: Part, pair = "fr-en") => `models/${pair}/v1/${type}.gz`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const remote = (type: Part, pair = "fr-en") => ({ path: pathOf(type, pair), hash: sha256(contents[type]), size: contents[type].byteLength });
const corruptFolder = join(folder, "en-fr");
mkdirSync(corruptFolder, { recursive: true });
writeFileSync(join(corruptFolder, "model"), Buffer.alloc(contents.model.byteLength, 9));
writeFileSync(join(corruptFolder, "lex"), contents.lex);
writeFileSync(join(corruptFolder, "vocab"), contents.vocab);
writeFileSync(
  join(corruptFolder, "manifest.json"),
  JSON.stringify({ version: "v1", files: { model: { size: contents.model.byteLength }, lex: { size: contents.lex.byteLength }, vocab: { size: contents.vocab.byteLength } } }),
);
mkdirSync(folder, { recursive: true });
writeFileSync(
  join(folder, "catalog.json"),
  JSON.stringify({
    source: `${STORE}db/models.json`,
    fetchedAt: Date.now(),
    pairs: {
      "fr>en": { version: "v1", files: { model: remote("model"), lex: remote("lex"), vocab: remote("vocab") } },
      "en>fr": { version: "v1", files: { model: remote("model", "en-fr"), lex: remote("lex", "en-fr"), vocab: remote("vocab", "en-fr") } },
    },
  }),
);

type Serve = (type: Part, signal: AbortSignal | undefined) => Response;
const plain = (type: Part) => new Response(gzipSync(contents[type]), { headers: { "content-length": String(gzipSync(contents[type]).byteLength) } });
let serve: Serve = plain;
const fetched: Part[] = [];
(net as { fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response> }).fetch = async (url, init) => {
  const type = (Object.keys(contents) as Part[]).find((name) => url === `${STORE}${pathOf(name)}` || url === `${STORE}${pathOf(name, "en-fr")}`);
  if (!type) return new Response(null, { status: 404 });
  fetched.push(type);
  return serve(type, init?.signal);
};

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => void unhandled.push(reason));

const models = await import("./models.ts");
const installed = async (pair: string) => await models.installed(pair);
const filesOf = async (pair: string) => await models.filesOf(pair);

after(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(pairFolder, { recursive: true, force: true });
  serve = plain;
  fetched.length = 0;
  unhandled.length = 0;
});

const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const leftovers = () => (existsSync(pairFolder) ? readdirSync(pairFolder).filter((name) => name.endsWith(".part")) : []);

function trickle(chunks: Buffer[], everyMs: number, onCancel: () => void, signal?: AbortSignal): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let next = 0;
      const push = () => {
        if (next >= chunks.length) return controller.close();
        controller.enqueue(new Uint8Array(chunks[next++]!));
        timer = setTimeout(push, everyMs);
      };
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        onCancel();
        controller.error(signal.reason);
      });
      push();
    },
    cancel() {
      clearTimeout(timer);
      onCancel();
    },
  });
  return new Response(body);
}

const split = (bytes: Buffer, parts: number) => Array.from({ length: parts }, (_, i) => bytes.subarray(Math.floor((i * bytes.length) / parts), Math.floor(((i + 1) * bytes.length) / parts)));

test("a pair downloads, checks out against Mozilla's hashes and is installed", async () => {
  const progress: number[] = [];
  assert.equal(await within(5_000, models.ensurePairs(["fr>en"], ({ received }) => progress.push(received))), 1);
  assert.equal(await installed("fr>en"), true);
  const files = await filesOf("fr>en");
  assert.ok(files);
  assert.deepEqual(readFileSync(files.model), contents.model);
  assert.ok(progress.length > 0);
  assert.deepEqual(leftovers(), []);
});

test("a corrupt gzip body fails the download cleanly: one rejection, nothing unhandled, no staging file", async () => {
  const corrupt = Buffer.concat([gzipSync(contents.model).subarray(0, 20), Buffer.alloc(200_000, 0xff)]);
  let cancelled = false;
  serve = (type, signal) => (type === "model" ? trickle(split(corrupt, 8), 30, () => (cancelled = true), signal) : plain(type));
  await assert.rejects(within(5_000, models.ensurePairs(["fr>en"], () => {})));
  await pause(100);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(leftovers(), []);
  assert.equal(cancelled, true);
  assert.equal(await installed("fr>en"), false);
});
