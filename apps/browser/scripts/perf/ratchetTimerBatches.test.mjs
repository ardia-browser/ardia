import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { flatten } from "./ratchet.mjs";

const CLOSE_WORK = { "event:topLayout": 80, "device:onAnimatedValueUpdate": 20, "event:topScroll": 20, callback: 257 };
const CLOSE_TIMERS = { "setTimeout:lookUp": 100, "setTimeout:benchSleep": 40 };

const openClose = (batches, work = CLOSE_WORK) => ({
  openClose: {
    openStats: { tasks: { "JSTimers.callTimers": batches, "event:topLayout": 80 }, timers: {} },
    closeStats: { tasks: { ...work, "JSTimers.callTimers": batches }, timers: CLOSE_TIMERS },
  },
});

const report = (...batches) => {
  const file = join(mkdtempSync(join(tmpdir(), "ratchet-batches-")), "report.json");
  writeFileSync(file, JSON.stringify({ label: "t", seed: "big", benchRevision: 5, results: batches.map((n) => ({ probeRevision: 2, ...openClose(n) })) }));
  return file;
};

const ratchetCli = fileURLToPath(new URL("./ratchet.mjs", import.meta.url));

const runCheck = (file) => spawnSync(process.execPath, [ratchetCli, "check", file], { encoding: "utf8" });

const checkStatus = (file) => runCheck(file).status;

test("two closes that differ only in how many timer batches the host made flatten to the same task total", () => {
  const macBook = flatten(openClose(390)).counts;
  const macMini = flatten(openClose(560)).counts;
  assert.equal(macBook["close.tasks"], 377);
  assert.equal(macMini["close.tasks"], 377);
  assert.equal(macBook["open.tasks"], macMini["open.tasks"]);
});

test("the timer batch is not a named task row either", () => {
  const { counts } = flatten(openClose(560));
  assert.equal(counts["close.tasks.JSTimers.callTimers"], undefined);
  assert.equal(counts["open.tasks.JSTimers.callTimers"], undefined);
  assert.equal(counts["close.tasks.event:topLayout"], 80);
});

test("the timers a batch runs are still counted under timers, harness sleeps left out", () => {
  const { counts } = flatten(openClose(560));
  assert.equal(counts["close.timers"], 100);
  assert.equal(counts["close.timers.setTimeout:lookUp"], 100);
  assert.equal(counts["close.timers.setTimeout:benchSleep"], undefined);
});

test("the check passes at the batch counts measured on the Mac mini and on the MacBook", () => {
  assert.equal(checkStatus(report(560)), 0);
  assert.equal(checkStatus(report(561)), 0);
  assert.equal(checkStatus(report(390)), 0);
  assert.equal(checkStatus(report(390, 560, 561)), 0);
});

test("the check still fails when a close does more work of its own", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ratchet-batches-")), "report.json");
  const results = [560, 560, 560].map((n) => ({ probeRevision: 2, ...openClose(n, { ...CLOSE_WORK, "event:topLayout": 200 }) }));
  writeFileSync(file, JSON.stringify({ label: "t", seed: "big", benchRevision: 5, results }));
  const { status, stdout } = runCheck(file);
  assert.equal(status, 1);
  assert.match(stdout, /OVER THE CEILING[\s\S]*close\.tasks\.event:topLayout/);
});
