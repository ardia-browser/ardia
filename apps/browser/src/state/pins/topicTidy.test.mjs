import assert from "node:assert/strict";
import { test } from "node:test";
const { validatedTopicPlan } = await import("./topicTidy.ts");

const tabs = [
  { id: "t1", title: "Pancakes", host: "recipes.com" },
  { id: "t2", title: "Souffle", host: "recipes.com" },
  { id: "t3", title: "Flights", host: "skyscanner.com" },
  { id: "t4", title: "Hotel", host: "booking.com" },
];
const groupIds = new Set(["g1"]);

test("bad ids drop, duplicates drop, 1-tab new groups drop, empty falls back", () => {
  const plan = validatedTopicPlan(
    {
      files: [
        { tabId: "t1", groupId: "g1" },
        { tabId: "nope", groupId: "g1" },
        { tabId: "t2", groupId: "gX" },
      ],
      newGroups: [
        { tabIds: ["t2", "t3"], name: "  Travel   Plans " },
        { tabIds: ["t4"], name: "Solo" },
        { tabIds: ["t2", "t3"], name: "Duplicate" },
      ],
    },
    tabs,
    groupIds,
  );
  assert.deepEqual(plan, {
    closes: [],
    files: [{ tabId: "t1", groupId: "g1" }],
    newGroups: [{ tabIds: ["t2", "t3"], name: "Travel Plans" }],
  });

  assert.equal(validatedTopicPlan({ files: [], newGroups: [] }, tabs, groupIds), null);
  assert.equal(validatedTopicPlan({ files: [{ tabId: "t1", groupId: "g1" }], newGroups: [] }, [], groupIds), null);
  assert.equal(validatedTopicPlan(null, tabs, groupIds), null);
  assert.equal(validatedTopicPlan("junk", tabs, groupIds), null);
  const longNamed = validatedTopicPlan({ files: [], newGroups: [{ tabIds: ["t2", "t3"], name: "x".repeat(80) }] }, tabs, groupIds);
  assert.ok(longNamed && longNamed.newGroups[0].name.length <= 32);
});
