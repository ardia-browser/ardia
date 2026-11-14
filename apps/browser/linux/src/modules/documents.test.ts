import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-documents-"));
process.env.ARDIA_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

type Fsp = typeof import("node:fs/promises");
type Handle = Awaited<ReturnType<Fsp["open"]>>;
const fsp = createRequire(import.meta.url)("node:fs/promises") as Fsp;
const real = { open: fsp.open, rename: fsp.rename, rm: fsp.rm, mkdir: fsp.mkdir };

const gate = { armed: false, count: 0, pauseAt: 0, paused: null as null | (() => void), reached: null as null | (() => void), inFlight: 0 };

async function step<T>(run: () => Promise<T>): Promise<T> {
  gate.inFlight++;
  try {
    if (gate.armed && ++gate.count === gate.pauseAt) {
      gate.reached?.();
      await new Promise<void>((resolve) => (gate.paused = resolve));
    }
    return await run();
  } finally {
    gate.inFlight--;
  }
}

function gatedHandle(handle: Handle): Handle {
  return new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "writeFile" || key === "sync" || key === "close" || key === "write" || key === "datasync")
        return (...args: unknown[]) => step(() => (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args));
      return (value as (...rest: unknown[]) => unknown).bind(target);
    },
  });
}

Object.assign(fsp, {
  open: (...args: Parameters<Fsp["open"]>) => step(() => real.open(...args)).then(gatedHandle),
  rename: (...args: Parameters<Fsp["rename"]>) => step(() => real.rename(...args)),
  rm: (...args: Parameters<Fsp["rm"]>) => step(() => real.rm(...args)),
  mkdir: (...args: Parameters<Fsp["mkdir"]>) => step(() => real.mkdir(...args)),
});
syncBuiltinESMExports();

type Documents = typeof import("./documents.ts");
let instance = 0;
const freshDocuments = async (): Promise<Documents> => (await import(`./documents.ts?instance=${++instance}`)) as Documents;

async function settled() {
  for (let quiet = 0; quiet < 5; ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    quiet = gate.inFlight === 0 ? quiet + 1 : 0;
  }
}

async function asyncStepsOfOneWrite(): Promise<number> {
  const documents = await freshDocuments();
  gate.count = 0;
  gate.armed = true;
  gate.pauseAt = Number.POSITIVE_INFINITY;
  documents.writeDocument(`count-${instance}.json`, "x");
  await settled();
  gate.armed = false;
  return gate.count;
}

async function pauseOldWriteAt(at: number, name: string, documents: Documents) {
  gate.count = 0;
  gate.pauseAt = at;
  gate.armed = true;
  const reached = new Promise<void>((resolve) => (gate.reached = resolve));
  documents.writeDocument(name, "old");
  await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error(`the write never reached step ${at}`)), 2000))]);
  gate.armed = false;
}

function release() {
  const resume = gate.paused;
  gate.paused = null;
  gate.reached = null;
  resume?.();
}

test("a write still in flight at quit can't land over what flushDocuments saved", async () => {
  const steps = await asyncStepsOfOneWrite();
  assert.ok(steps >= 2, `one write took ${steps} async steps`);
  for (let at = 1; at <= steps; at++) {
    const documents = await freshDocuments();
    const name = `flushed-${at}.json`;
    await pauseOldWriteAt(at, name, documents);
    documents.writeDocument(name, "new");
    assert.equal(documents.flushDocuments(), 0);
    assert.equal(readFileSync(join(dataDir, name), "utf8"), "new");
    release();
    await settled();
    assert.equal(readFileSync(join(dataDir, name), "utf8"), "new", `the old write paused at step ${at} of ${steps} landed after the flush`);
  }
});

test("a write still in flight when its document is removed doesn't bring it back", async () => {
  const steps = await asyncStepsOfOneWrite();
  for (let at = 1; at <= steps; at++) {
    const documents = await freshDocuments();
    const name = `removed-${at}.json`;
    await pauseOldWriteAt(at, name, documents);
    documents.removeDocument(name);
    documents.flushDocuments();
    release();
    await settled();
    assert.equal(existsSync(join(dataDir, name)), false, `the old write paused at step ${at} of ${steps} recreated a removed document`);
  }
});

test("writes that aren't raced still land, newest last", async () => {
  const documents = await freshDocuments();
  documents.writeDocument("plain.json", "1");
  documents.writeDocument("plain.json", "2");
  await settled();
  assert.equal(readFileSync(join(dataDir, "plain.json"), "utf8"), "2");
  assert.equal(documents.readDocument("plain.json"), "2");
  documents.writeDocument("plain.json", "3");
  await settled();
  assert.equal(readFileSync(join(dataDir, "plain.json"), "utf8"), "3");
});
