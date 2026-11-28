import assert from "node:assert/strict";
import { test } from "node:test";
import { callNow } from "./callNow.ts";

test("the bridge call starts before the caller's next statement", () => {
  const order: string[] = [];
  callNow(async () => void order.push("bridge"));
  order.push("next");
  assert.deepEqual(order, ["bridge", "next"]);
});

test("a call that throws or rejects is swallowed", async () => {
  callNow(() => {
    throw new Error("no module");
  });
  callNow(() => Promise.reject(new Error("rejected")));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
