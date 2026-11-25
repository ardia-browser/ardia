import assert from "node:assert/strict";
import { test } from "node:test";

const { layout } = await import("../ui/theme.ts");
const { groupMembersTop } = await import("./groupPlace.ts");
const { entryKey } = await import("../../state/sidebar/entryKey.ts");
const g = (id) => entryKey("group", id);

const ROW = 30;
const gap = layout.rowGap;
const state = (groups) => ({ groups, tabs: {} });
const members = { outer: ["tab:a", g("inner"), "tab:b"], inner: ["tab:c", "tab:d"], pinnedGroup: ["tab:e"] };
const places = (sections) => ({ sections, membersOf: (_s, id) => members[id] ?? [], membersTop: () => 10, height: () => ROW });

test("a top-level group's members start below its header, from the list it was in before the close", () => {
  const s = state({ outer: { id: "outer" } });
  const before = ["tab:x", "tab:y", g("outer")];
  assert.equal(groupMembersTop(s, "outer", places([{ list: before, base: 0 }])), 2 * (ROW + gap) + 10);
  assert.equal(groupMembersTop(s, "outer", places([{ list: [g("outer")], base: 0 }])), 10, "after the close the place differs");
});

test("a nested group resolves through its parent", () => {
  const s = state({ outer: { id: "outer" }, inner: { id: "inner", parentId: "outer" } });
  const outerTop = ROW + gap + 10;
  assert.equal(groupMembersTop(s, "inner", places([{ list: ["tab:x", g("outer")], base: 0 }])), outerTop + (ROW + gap) + 10);
});

test("a pinned group resolves in the pinned section, above the list", () => {
  const s = state({ pinnedGroup: { id: "pinnedGroup" } });
  assert.equal(groupMembersTop(s, "pinnedGroup", places([{ list: ["tab:x"], base: 0 }, { list: ["tab:p", g("pinnedGroup")], base: -200 }])), -200 + ROW + gap + 10);
  assert.equal(groupMembersTop(s, "missing", places([{ list: [], base: 0 }])), null);
});

const { groupSeen } = await import("./groupPlace.ts");

test("the New Tab row above the list moves only the list's groups, not the pinned ones above it", () => {
  const s = state({ listGroup: { id: "listGroup" }, pinnedGroup: { id: "pinnedGroup" } });
  const membersOf = (_s, id) => members[id] ?? ["tab:m"];
  const inputs = (above) => ({ entries: [g("listGroup")], viewport: { band: () => ({ top: -100, bottom: 50 }) }, above, pinned: () => ({ list: [g("pinnedGroup")], base: -80 }) });
  const seen = (above, groupId) => groupSeen(() => inputs(above), () => ROW, membersOf)(groupId, 0, ROW, s);
  assert.equal(seen(0, "pinnedGroup"), true);
  assert.equal(seen(500, "pinnedGroup"), true, "a New Tab row below the pinned section doesn't move it");
  assert.equal(seen(0, "listGroup"), true);
  assert.equal(seen(500, "listGroup"), false, "it moves the list's groups down");
});

test("a pinned group is placed among the entries the fold shows, not every pinned one", () => {
  const s = state({ pinnedGroup: { id: "pinnedGroup" } });
  const shown = { entries: [], viewport: { band: () => ({ top: -40, bottom: 0 }) }, above: 0, pinned: () => ({ list: [g("pinnedGroup")], base: -40 }) };
  const all = { ...shown, pinned: () => ({ list: [...Array.from({ length: 15 }, (_, i) => `t:${i}`), g("pinnedGroup")], base: -40 }) };
  const membersOf = () => ["tab:m"];
  assert.equal(groupSeen(() => shown, () => ROW, membersOf)("pinnedGroup", -10, 5, s), true);
  assert.equal(groupSeen(() => all, () => ROW, membersOf)("pinnedGroup", -10, 5, s), false, "15 hidden rows counted above would cull it");
});
