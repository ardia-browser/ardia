import assert from "node:assert/strict";
import { test } from "node:test";
const { dragGeometry, dropIndex } = await import("./stripGroups.ts");

test("a group dragged in place reorders by its edges, as its drop callback does", () => {
  const wide = dragGeometry([{ tabIds: ["g1", "g2", "g3", "g4"], width: 400 }, { tabIds: ["t"], width: 100 }], 4);
  assert.equal(dropIndex(wide, 0, 104), 1, "the group's travel past the narrow tab");
});

test("a tab passes its neighbour once its edge crosses the neighbour's middle", () => {
  const tabs = dragGeometry([{ tabIds: ["a"], width: 100 }, { tabIds: ["b"], width: 100 }, { tabIds: ["c"], width: 100 }], 4);
  assert.equal(dropIndex(tabs, 0, 50), 0);
  assert.equal(dropIndex(tabs, 0, 60), 1);
  assert.equal(dropIndex(tabs, 2, -60), 1);
});
