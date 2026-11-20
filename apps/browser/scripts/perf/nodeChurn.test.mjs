import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { flatten, JOURNEYS } from "./ratchet.mjs";

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
