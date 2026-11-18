import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const { groupEntries } = await import("./entries.ts");
const { entryKey } = await import("./entryKey.ts");
const rows = (...ids) => ids.map((id) => entryKey("tab", id));

const tab = (id) => ({ id, url: `https://memo.test/${id}`, pin: null, liveItem: null, profileId: "p", page: null });
const tabs = Object.fromEntries(["a1", "a2", "b1", "b2"].map((id) => [id, tab(id)]));
const group = (id, version, tabIds) => ({ id, name: `${id}${version}`, tabIds, parentId: null, pinned: false });
const splits = {};

function replaceInTurn(rounds) {
  let a = group("A", 0, ["a1", "a2"]);
  let b = group("B", 0, ["b1", "b2"]);
  let groups = { A: a, B: b };
  groupEntries({ tabs, splits, groups }, "A");
  groupEntries({ tabs, splits, groups }, "B");
  const first = new WeakRef(groups);
  const versions = [];
  for (let i = 1; i <= rounds; i++) {
    const changed = i % 2 ? "B" : "A";
    if (changed === "A") a = group("A", i, ["a1", "a2"]);
    else b = group("B", i, ["b1", "b2"]);
    groups = { A: a, B: b };
    versions.push(new WeakRef(groups));
    assert.deepEqual(groupEntries({ tabs, splits, groups }, changed), changed === "A" ? rows("a1", "a2") : rows("b1", "b2"));
  }
  return { first, versions, newest: groups };
}

test("asking only for the group that changed keeps no earlier groups record alive", async () => {
  const { first, versions, newest } = replaceInTurn(400);
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  assert.equal(first.deref(), undefined);
  assert.ok(versions.filter((v) => v.deref() !== undefined).length <= 2, "at most the newest records stay reachable");
  assert.ok(newest.A && newest.B);
});

test("a group's entries come from its memo while the groups record, splits and tab places are the same", () => {
  const groups = { A: group("A", 0, ["a1", "a2"]) };
  const first = groupEntries({ tabs, splits, groups }, "A");
  assert.equal(groupEntries({ tabs, splits, groups }, "A"), first);
  assert.equal(groupEntries({ tabs: { ...tabs }, splits, groups }, "A"), first);
  const regrouped = { ...groups, C: group("C", 0, []) };
  assert.deepEqual(groupEntries({ tabs, splits, groups: regrouped }, "A"), first);
});
