import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
const { changedIds } = await import("./changes.ts");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("changedIds lists added, changed and removed ids and answers a repeated pair from its memo", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const prev = { a, b };
  const next = { a, b: { id: "b" }, c: { id: "c" } };
  const ids = changedIds(next, prev);
  assert.deepEqual([...ids].sort(), ["b", "c"]);
  assert.equal(changedIds(next, prev), ids);
  assert.deepEqual(changedIds({ a }, prev), ["b"]);
  assert.equal(changedIds(next, next).length, 0);
});

test("the memo keeps no earlier record alive through the records that replaced it", async () => {
  const replaceOneTabAtATime = () => {
    const first = { t0: { title: "0" } };
    let prev = first;
    for (let i = 1; i <= 1000; i++) {
      const next = { ...prev, [`t${i % 40}`]: { title: String(i) } };
      changedIds(next, prev);
      changedIds(next, prev);
      prev = next;
    }
    return { first: new WeakRef(first), newest: prev };
  };
  const { first, newest } = replaceOneTabAtATime();
  await nextTurn();
  gc();
  assert.equal(first.deref(), undefined);
  assert.equal(Object.keys(newest).length, 40);
});
