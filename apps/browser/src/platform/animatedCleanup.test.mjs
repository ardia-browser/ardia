import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the Mac app turns off React Native's microtask cleanup for animated props before anything else loads", () => {
  const entry = read("../../index.js");
  assert.equal(entry.split("\n").find((line) => line.startsWith("import ")), 'import "./src/platform/animatedCleanup";');
  assert.match(read("./animatedCleanup.ts"), /flags\.override\(\{ scheduleAnimatedCleanupInMicrotask: \(\) => false \}\)/);
});

test("Windows keeps React Native's own default", () => {
  assert.equal(read("./animatedCleanup.windows.ts").trim(), "");
});

test("a cancellation caused by detaching runs its callback after the commit; other endings stay synchronous", async () => {
  const warn = console.warn;
  console.warn = () => {};
  const { deferCancellationsDuringDetach } = await import("./animatedCleanup.ts");
  console.warn = warn;
  const calls = [];
  const animation = { __notifyAnimationEnd: (result) => calls.push(result.finished ? "finished" : "cancelled") };
  const value = { __detach: () => animation.__notifyAnimationEnd({ finished: false }) };
  deferCancellationsDuringDetach(animation, value);
  value.__detach();
  assert.deepEqual(calls, [], "not during the detach");
  await Promise.resolve();
  assert.deepEqual(calls, ["cancelled"]);
  animation.__notifyAnimationEnd({ finished: false });
  animation.__notifyAnimationEnd({ finished: true });
  assert.deepEqual(calls, ["cancelled", "cancelled", "finished"]);
});

test("the override fails open: React Native's default stays if the flag is missing or was read first", () => {
  const source = read("./animatedCleanup.ts");
  assert.match(source, /typeof flags\.scheduleAnimatedCleanupInMicrotask !== "function"/);
  assert.match(source, /\} catch \(error\) \{/);
});
