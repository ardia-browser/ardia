import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { announceShellPainted } from "./shellPainted.ts";

function frames() {
  const queue = [];
  return { next: (callback) => queue.push(callback), run: () => queue.splice(0).forEach((callback) => callback()) };
}

test("the shell says it painted only after its first frame has been produced", async () => {
  const calls = [];
  const clock = frames();
  const host = { bootstrap: { windowId: "w7" }, invoke: async (method, params) => { calls.push([method, params]); return null; } };
  const announced = announceShellPainted(host, clock.next);
  clock.run();
  assert.deepEqual(calls, []);
  clock.run();
  await announced;
  assert.deepEqual(calls, [["ArdiaShell.shellPainted", { args: ["w7"] }]]);
});

test("a refused painted call leaves the curtain to its deadline without throwing", async () => {
  const clock = frames();
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  try {
    const announced = announceShellPainted({ bootstrap: { windowId: "w1" }, invoke: () => Promise.reject(new Error("No such native window")) }, clock.next);
    clock.run();
    clock.run();
    await announced;
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
});

test("the first window commit announces the paint and the engine lifts the curtain on it", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  const committed = main.slice(main.indexOf("function FirstWindowCommitted"), main.indexOf("async function start()"));
  assert.match(committed, /announceShellPainted\(ardiaHost\)/);
  const engine = readFileSync(new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_host.cc", import.meta.url), "utf8");
  assert.match(engine, /method == "ArdiaShell\.shellPainted"\) \{\n\s+if \(target != this\)[^\n]*\n\s+ShellPainted\(\);/);
  assert.doesNotMatch(engine, /DidFirstVisuallyNonEmptyPaint/);
});
