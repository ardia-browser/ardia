import assert from "node:assert/strict";
import { test } from "node:test";

const frames = [];
globalThis.requestAnimationFrame = (run) => frames.push(run);
const drain = async () => {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    const due = frames.splice(0);
    for (const run of due) run(0);
  }
};
const { fillingFold, flushFolds, foldsFilling } = await import("./foldFlush.ts");

test("a flush keeps going until no fold in the window is pending, so a child that registers during it is flushed too", async () => {
  const ran = [];
  const parent = fillingFold("w1", () => {
    ran.push("parent");
    parent();
    const child = fillingFold("w1", () => {
      ran.push("child");
      child();
    });
  });
  const done = flushFolds("w1");
  await drain();
  await done;
  assert.deepEqual(ran, ["parent", "child"]);
  assert.equal(foldsFilling("w1"), false);
});

test("a flush stays in its own window", async () => {
  const ran = [];
  const other = fillingFold("w2", () => ran.push("w2"));
  const mine = fillingFold("w1", () => {
    ran.push("w1");
    mine();
  });
  const done = flushFolds("w1");
  await drain();
  await done;
  assert.deepEqual(ran, ["w1"]);
  assert.equal(foldsFilling("w2"), true);
  other();
});

test("R5-S6: a flush keeps going while rounds make progress, and says so when one makes none", async () => {
  const chain = [];
  const link = (n) => {
    const stop = fillingFold("w3", () => {
      chain.push(n);
      stop();
      if (n < 12) link(n + 1);
    });
  };
  link(1);
  let done = flushFolds("w3");
  await drain();
  assert.equal(await done, true);
  assert.equal(chain.length, 12, "deeper than any fixed cap of rounds");
  const stuck = fillingFold("w4", () => {});
  done = flushFolds("w4");
  await drain();
  assert.equal(await done, false, "a round that settles nothing reports the flush incomplete");
  stuck();
});
