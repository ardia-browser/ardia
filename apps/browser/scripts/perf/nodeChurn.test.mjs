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
