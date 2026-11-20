import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRefusal, isHarnessTimer } from "./js-bench.mjs";

test("--append adds to a report only of the same bench revision", () => {
  assert.equal(appendRefusal(null, 4), null);
  assert.equal(appendRefusal({ benchRevision: 4, results: [] }, 4), null);
  assert.match(appendRefusal({ benchRevision: 3, results: [] }, 4), /revision 3 report/);
  assert.match(appendRefusal({ results: [] }, 4), /revision unknown report/);
});

test("the harness's own timers are named and left out of the counts, an app's anonymous timer is not", () => {
  for (const name of ["setTimeout:benchSleep", "setTimeout:benchSettleStep", "setInterval:anonymous", "setTimeout:pollDevEval"]) assert.equal(isHarnessTimer(name), true, name);
  for (const name of ["setTimeout:anonymous", "setTimeout:syncMenu", "setImmediate:anonymous"]) assert.equal(isHarnessTimer(name), false, name);
});
