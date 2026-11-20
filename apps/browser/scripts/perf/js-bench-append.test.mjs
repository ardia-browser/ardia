import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRefusal } from "./js-bench.mjs";

test("--append adds to a report only of the same bench revision", () => {
  assert.equal(appendRefusal(null, 4), null);
  assert.equal(appendRefusal({ benchRevision: 4, results: [] }, 4), null);
  assert.match(appendRefusal({ benchRevision: 3, results: [] }, 4), /revision 3 report/);
  assert.match(appendRefusal({ results: [] }, 4), /revision unknown report/);
});
