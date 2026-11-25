import assert from "node:assert/strict";
import test from "node:test";
import { serialQueue } from "./serialQueue.ts";

test("queued work runs one at a time in arrival order, so a slow earlier action can't finish after a later one", async () => {
  const seen: string[] = [];
  const push = serialQueue();
  let releaseInbox = () => {};
  push(async () => {
    seen.push("inbox-start");
    await new Promise<void>((done) => (releaseInbox = done));
    seen.push("deck");
  });
  const open = push(async () => {
    seen.push("open");
  });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen, ["inbox-start"]);
  releaseInbox();
  await open;
  assert.deepEqual(seen, ["inbox-start", "deck", "open"]);
});

test("a failed action doesn't stop the ones after it", async () => {
  const seen: string[] = [];
  const push = serialQueue();
  push(async () => {
    throw new Error("inbox");
  });
  await push(async () => {
    seen.push("open");
  });
  assert.deepEqual(seen, ["open"]);
});

test("work that never finishes is given up on at its deadline, so the next one still runs", async () => {
  const seen: string[] = [];
  const push = serialQueue(30);
  push(() => new Promise<void>(() => seen.push("hung")));
  const began = Date.now();
  await push(async () => {
    seen.push("open");
  });
  assert.deepEqual(seen, ["hung", "open"]);
  assert.ok(Date.now() - began < 1000);
});

test("work that finishes in time doesn't wait for the deadline", async () => {
  const push = serialQueue(5_000);
  const began = Date.now();
  await push(async () => undefined);
  await push(async () => undefined);
  assert.ok(Date.now() - began < 1000);
});

test("work that outlives its deadline can tell, so it doesn't act over what ran after it", async () => {
  const seen: string[] = [];
  const push = serialQueue(20);
  let finish = () => {};
  push(async (expired) => {
    await new Promise<void>((done) => (finish = done));
    if (!expired()) seen.push("deck");
  });
  await push(async () => {
    seen.push("open");
  });
  finish();
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(seen, ["open"]);
});

test("each piece of work given up on is reported once", async () => {
  let late = 0;
  const push = serialQueue(10, () => late++);
  push(() => new Promise<void>(() => undefined));
  await push(async () => undefined);
  await push(async () => undefined);
  assert.equal(late, 1);
});
