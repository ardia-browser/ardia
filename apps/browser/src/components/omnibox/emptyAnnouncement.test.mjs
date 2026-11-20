import assert from "node:assert/strict";
import { test } from "node:test";
const { emptyAnnouncement } = await import("./emptyAnnouncement.ts");

const steps = (frames) => {
  let announced = null;
  const said = [];
  for (const [empty, hasRows] of frames) {
    const step = emptyAnnouncement(announced, empty, hasRows);
    announced = step.announced;
    if (step.say) said.push(step.say);
  }
  return said;
};

test("the empty state is announced once when it appears", () => {
  assert.deepEqual(steps([[null, false], ["No results from Notes", false]]), ["No results from Notes"]);
});

test("typing on while the provider still finds nothing does not repeat it, pending queries included", () => {
  const empty = "No results from Notes";
  assert.deepEqual(steps([[empty, false], [null, false], [empty, false], [null, false], [empty, false]]), [empty]);
});

test("after real rows show, a new empty state is announced again", () => {
  const empty = "No results from Notes";
  assert.deepEqual(steps([[empty, false], [null, true], [empty, false]]), [empty, empty]);
});

test("another provider's empty state is announced", () => {
  assert.deepEqual(steps([["No results from Notes", false], ["No results from Wiki", false]]), ["No results from Notes", "No results from Wiki"]);
});

test("the live region gets the text when the empty state appears, keeps it while queries are pending and empties when rows come back", () => {
  const empty = "No results from Notes";
  const frames = [[null, false], [empty, false], [null, false], [empty, false], [null, true], [null, false]];
  let announced = null;
  const region = [];
  for (const [shown, hasRows] of frames) {
    announced = emptyAnnouncement(announced, shown, hasRows).announced;
    region.push(announced ?? "");
  }
  assert.deepEqual(region, ["", empty, empty, empty, "", ""]);
});
