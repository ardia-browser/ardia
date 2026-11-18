import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
const { withPages, pagesWrittenSince } = await import("./pagesWritten.ts");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const writeOneByOne = (count, from = {}) => {
  const versions = [from];
  for (let i = 0; i < count; i++) versions.push(withPages(versions.at(-1), [[`https://site.test/${i}`, `icon-${i}`]]));
  return versions;
};

test("pagesWrittenSince lists the pages of up to 16 writes back and answers null past that", () => {
  const versions = writeOneByOne(40);
  const now = versions.at(-1);
  assert.deepEqual(pagesWrittenSince(now, now), []);
  assert.deepEqual(pagesWrittenSince(now, versions.at(-2)), ["https://site.test/39"]);
  assert.equal(pagesWrittenSince(now, versions.at(-17)).length, 16);
  assert.equal(pagesWrittenSince(now, versions.at(-18)), null);
});

test("pagesWrittenSince answers null for pages it never saw and follows each profile's own writes", () => {
  const unseen = { "https://a.test": "icon-a" };
  assert.equal(pagesWrittenSince({ ...unseen }, unseen), null);
  assert.deepEqual(pagesWrittenSince(unseen, unseen), []);
  let work = {};
  let home = {};
  const workStart = work;
  for (let i = 0; i < 10; i++) {
    work = withPages(work, [[`https://work.test/${i}`, "w"]]);
    home = withPages(home, [[`https://home.test/${i}`, "h"]]);
  }
  assert.deepEqual(pagesWrittenSince(work, workStart).sort(), Array.from({ length: 10 }, (_, i) => `https://work.test/${i}`).sort());
  assert.equal(pagesWrittenSince(work, home), null);
});

test("the newest pages keep no earlier version alive", async () => {
  const writeMany = () => {
    const first = {};
    const versions = writeOneByOne(200, first);
    return { first: new WeakRef(first), newest: versions.at(-1) };
  };
  const { first, newest } = writeMany();
  await nextTurn();
  gc();
  assert.equal(first.deref(), undefined);
  assert.equal(Object.keys(newest).length, 200);
});
