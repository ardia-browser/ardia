import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ceilingsFrom, flatten, JOURNEYS } from "./ratchet.mjs";

test("the ratchet runs the native-node churn and gates the nodes it leaves behind at zero", () => {
  assert.equal(JOURNEYS.at(-1), "nodeChurn");
  const { counts, ran } = flatten({ nodeChurn: { start: 362, end: 362, left: 0 } });
  assert.ok(ran.has("nodeChurn"));
  assert.equal(counts["nodeChurn.nativeNodesLeft"], 0);
  assert.equal(JSON.parse(readFileSync(new URL("./ratchet.json", import.meta.url), "utf8")).exact["nodeChurn.nativeNodesLeft"], 0);
});

test("a bundle without the probe's node counter reports nothing rather than zero", () => {
  const { counts, ran } = flatten({ nodeChurn: { left: null } });
  assert.ok(!ran.has("nodeChurn"));
  assert.equal(counts["nodeChurn.nativeNodesLeft"], undefined);
});

const checkWith = (...lefts) => {
  const report = join(mkdtempSync(join(tmpdir(), "node-churn-")), "report.json");
  writeFileSync(report, JSON.stringify({ label: "t", seed: "big", benchRevision: 4, results: lefts.map((left) => ({ probeRevision: 2, nodeChurn: { start: 10, end: 10 + left, left } })) }));
  return spawnSync(process.execPath, [new URL("./ratchet.mjs", import.meta.url).pathname, "check", report], { encoding: "utf8" }).status;
};

test("one native node left behind fails the check: the zero ceiling gets no named-count room", () => {
  assert.equal(checkWith(0), 0);
  assert.equal(checkWith(1), 1);
  assert.equal(checkWith(2), 1);
});

test("rebuilding the baseline keeps the zero row for nodes left behind", () => {
  const { exact } = ceilingsFrom({ "nodeChurn.nativeNodesLeft": [0, 0, 0, 0, 0, 0], "open.renders.Gone": [0, 0, 0, 0, 0, 0] });
  assert.equal(exact["nodeChurn.nativeNodesLeft"], 0);
  assert.equal("open.renders.Gone" in exact, false);
});

test("one leaking run among clean ones fails the check: nodes left behind are judged by the worst run, not the median", () => {
  assert.equal(checkWith(0, 0, 0), 0);
  assert.equal(checkWith(1, 0, 0), 1);
  assert.equal(checkWith(0, 0, 2), 1);
});

const benchSource = readFileSync(new URL("./bench-app.js", import.meta.url), "utf8");
const ratchetSource = readFileSync(new URL("./ratchet-app.js", import.meta.url), "utf8");

function churnApp({ leakPerOpen = 0, leakAfterLastSwitchMs = null } = {}) {
  const nodes = { created: 578, dropped: 0 };
  let next = 0;
  let lateTimer = null;
  const tabIds = Array.from({ length: 30 }, (_, i) => `t${i}`);
  const state = {
    ui: { focusOrder: ["w"] },
    windows: { w: { profileId: "p", activeTabIds: { p: "t0" }, tabIds } },
    tabs: {},
    newTab() {
      const id = `n${next++}`;
      setTimeout(() => (nodes.created += 13 + leakPerOpen), 12);
      return id;
    },
    closeTab() {
      setTimeout(() => (nodes.dropped += 13), 8);
    },
    activate() {
      if (leakAfterLastSwitchMs === null) return;
      clearTimeout(lateTimer);
      lateTimer = setTimeout(() => (nodes.created += 1), leakAfterLastSwitchMs);
    },
  };
  globalThis.acPerf = { now: () => Date.now(), batch: (fn) => fn(), reset() {}, read: () => ({ writes: {}, timers: {} }), marks: {}, nativeNodes: () => ({ ...nodes, live: nodes.created - nodes.dropped }) };
  const ac = { store: { getState: () => state, subscribe: () => () => {} }, tabLive: { liveOf: () => ({ isLoading: false }) } };
  new Function("ac", benchSource)(ac);
  new Function("ac", ratchetSource)(ac);
  return globalThis.acBench;
}

const churn = { origin: "http://h", opens: 6, switches: 12 };

test("a churn that leaves nothing behind reports zero", { timeout: 20_000 }, async () => {
  const result = await churnApp().run("nodeChurn", churn);
  assert.equal(result.left, 0);
});

test("a node leaked on every open is counted once per open", { timeout: 20_000 }, async () => {
  assert.equal((await churnApp({ leakPerOpen: 1 }).run("nodeChurn", churn)).left, churn.opens);
});

test("a node leaked half a second after the last switch is still caught: the tail waits for the counter to go quiet", { timeout: 20_000 }, async () => {
  assert.ok((await churnApp({ leakAfterLastSwitchMs: 500 }).run("nodeChurn", churn)).left >= 1);
});

test("a node leaked a full second after the last switch is still caught: the churn watches for the old 2.5 s", { timeout: 20_000 }, async () => {
  assert.ok((await churnApp({ leakAfterLastSwitchMs: 1000 }).run("nodeChurn", churn)).left >= 1);
});

test("a node leaked two seconds after the last switch is still caught", { timeout: 20_000 }, async () => {
  assert.ok((await churnApp({ leakAfterLastSwitchMs: 2000 }).run("nodeChurn", churn)).left >= 1);
});
