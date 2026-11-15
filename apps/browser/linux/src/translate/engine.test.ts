import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "ardia-translate-engine-"));
const workerLog = join(scratch, "bergamot", "requests.jsonl");
mkdirSync(join(scratch, "bergamot"));
writeFileSync(
  join(scratch, "translateWorker.js"),
  `const { parentPort, workerData } = require("node:worker_threads");
const { appendFileSync } = require("node:fs");
const log = require("node:path").join(require("node:path").dirname(workerData.glue), "requests.jsonl");
parentPort.on("message", (request) => {
  appendFileSync(log, JSON.stringify({ op: request.op, texts: (request.texts || []).map((t) => t.text) }) + "\\n");
  if (request.op !== "translate") return parentPort.postMessage({ id: request.id });
  if (request.texts.some((t) => t.text.includes("HANG"))) return;
  parentPort.postMessage({ id: request.id, result: request.texts.map((t) => (t.html ? t.text : t.text.toUpperCase())) });
});
`,
);
const pairFolder = join(scratch, "data", "Translations", "fr-en");
mkdirSync(pairFolder, { recursive: true });
for (const name of ["model", "lex", "vocab"]) writeFileSync(join(pairFolder, name), name);
writeFileSync(join(pairFolder, "manifest.json"), JSON.stringify({ version: "1", files: { model: { size: 5 }, lex: { size: 3 }, vocab: { size: 5 } } }));
process.env.ARDIA_DATA_DIR = join(scratch, "data");
(globalThis as { __dirname?: string }).__dirname = scratch;

const engine = await import("./engine.ts");
const { cancelOwner, openOwner, translatePassages, translateTexts } = engine;
const limits = (engine as { translationLimits?: { queuedPerOwner: number; deadlineBaseMs: number; deadlinePerKiBMs: number } }).translationLimits;

after(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => writeFileSync(workerLog, ""));

const seen = () =>
  readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; texts: string[] })
    .filter((request) => request.op === "translate")
    .flatMap((request) => request.texts);
const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);
const settled = (promise: Promise<unknown>) => promise.then(() => "resolved", () => "rejected");

test("a normal passage is translated", async () => {
  openOwner("normal");
  assert.deepEqual(await within(5_000, translatePassages("fr", "en", [["bonjour le monde"]], "normal")), [["BONJOUR LE MONDE"]]);
  cancelOwner("normal");
});

test("a passage over the size cap is refused in the main process and never reaches the worker", async () => {
  openOwner("big");
  const huge = "é".repeat(200_000);
  const result = await within(5_000, translatePassages("fr", "en", [[huge], ["petit texte"]], "big"));
  assert.equal(result[0], null);
  assert.deepEqual(result[1], ["PETIT TEXTE"]);
  assert.ok(seen().every((text) => text.length < 1_000));
  cancelOwner("big");
});

test("a request over the passage count or byte cap is refused whole", async () => {
  openOwner("many");
  await assert.rejects(within(5_000, translatePassages("fr", "en", Array.from({ length: 5_000 }, (_, i) => [`phrase ${i}`]), "many")));
  await assert.rejects(within(5_000, translatePassages("fr", "en", Array.from({ length: 40 }, (_, i) => [`${i} ${"x".repeat(30_000)}`]), "many")));
  assert.deepEqual(seen(), []);
  cancelOwner("many");
});

test("direct translate calls get the same caps", async () => {
  assert.deepEqual(await within(5_000, translateTexts("fr", "en", ["salut", "x".repeat(200_000)])), ["SALUT", null]);
  await assert.rejects(within(5_000, translateTexts("fr", "en", Array.from({ length: 5_000 }, () => "salut"))));
  assert.ok(seen().every((text) => text.length < 1_000));
});

test("one page can't queue without bound: past its cap new requests are refused at once", async () => {
  assert.ok(limits, "the engine has no limits");
  limits.deadlineBaseMs = 60_000;
  openOwner("flood");
  const stuck = translatePassages("fr", "en", [["HANG"]], "flood");
  const flood = Array.from({ length: 50 }, (_, i) => translatePassages("fr", "en", [[`phrase ${i}`]], "flood"));
  const outcomes = await within(2_000, Promise.all(flood.slice(limits.queuedPerOwner).map(settled)));
  assert.ok(outcomes.every((outcome) => outcome === "rejected"));
  cancelOwner("flood");
  const drained = await within(2_000, Promise.all([stuck, ...flood.slice(0, limits.queuedPerOwner)].map(settled)));
  assert.equal(drained.length, limits.queuedPerOwner + 1);
  assert.ok(seen().filter((text) => text.startsWith("phrase")).length < limits.queuedPerOwner);
});

test("a stuck worker is stopped at the deadline and a fresh one takes the next request", async () => {
  assert.ok(limits, "the engine has no limits");
  limits.deadlineBaseMs = 300;
  limits.deadlinePerKiBMs = 0;
  openOwner("stuck");
  await assert.rejects(within(3_000, translatePassages("fr", "en", [["HANG"]], "stuck")));
  assert.deepEqual(await within(3_000, translatePassages("fr", "en", [["après"]], "stuck")), [["APRÈS"]]);
  cancelOwner("stuck");
  limits.deadlineBaseMs = 60_000;
});

test("cancelling drops the page's queued work and stops its running work, so other pages go on", async () => {
  openOwner("leaving");
  openOwner("staying");
  const running = translatePassages("fr", "en", [["HANG"]], "leaving");
  const queued = Array.from({ length: 3 }, (_, i) => translatePassages("fr", "en", [[`file ${i}`]], "leaving"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelOwner("leaving");
  const left = await within(2_000, Promise.all([running, ...queued]));
  assert.ok(left.every((result) => result.every((passage) => passage === null)));
  assert.deepEqual(await within(2_000, translatePassages("fr", "en", [["reste"]], "staying")), [["RESTE"]]);
  assert.ok(!seen().some((text) => text.startsWith("file")));
  cancelOwner("staying");
});
