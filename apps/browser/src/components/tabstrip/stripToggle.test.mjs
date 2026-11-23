import assert from "node:assert/strict";
import { test } from "node:test";
const { groupLayout, layoutStrip, MEMBERS_INSET, nameGrowth, stripFit } = await import("./stripGroups.ts");
const { groupChipWidth, revealedMembers, toggleFrame } = await import("./stripToggle.ts");
const { GAP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT, TITLE_MIN_CHIP } = await import("./tokens.ts");

const own = (id, group = null) => ({ kind: "tab", id, group });
const folder = (id, tabIds, group) => ({ kind: "folder", id, tabIds, group });
const FOLDERS = { comp: 74, similar: 86, housing: 88, dev: 62, prod: 66, service: 90 };
const GROUP_CHIP = 78;

function strip(alphaCollapsed) {
  const alpha = {
    kind: "group",
    id: "alpha",
    collapsed: alphaCollapsed,
    members: [folder("comp", ["c1", "c2"], "alpha"), own("news", "alpha"), ...["similar", "housing", "dev", "prod", "service"].map((id) => folder(id, [`${id}1`], "alpha"))],
  };
  const three = { kind: "group", id: "three", collapsed: true, members: ["x1", "x2", "x3"].map((id) => own(id, "three")) };
  return [alpha, three, own("notes"), own("cloud"), own("party"), own("cli"), own("act")];
}

const measures = { groupChip: () => GROUP_CHIP, folderChip: (id) => FOLDERS[id], needsTitle: (id) => ["notes", "cloud", "party", "cli"].includes(id) };
const PAGE = 1020;
const loose = ["notes", "cloud", "party", "cli", "act"];

function laidOut(entries) {
  const fit = stripFit(entries, "act", PAGE, measures, null);
  const layout = layoutStrip(entries, "act", PAGE, measures, null, undefined, "act", fit.selectedMin, fit.titledMin, fit.compactMin);
  return { fit, layout, width: (id) => layout.tabWidth(id) };
}

const FRAMES = Array.from({ length: 13 }, (_, i) => i / 12);

test("opening a group whose folders were measured while it was closed: every frame reveals the same members at their final places, unsqueezed and never overlapping", () => {
  const after = laidOut(strip(false));
  const alpha = strip(false)[0];
  const widths = alpha.members.map(after.layout.memberWidth);
  const open = groupLayout(GROUP_CHIP, widths, GAP, true, -1);
  const closed = groupLayout(GROUP_CHIP, widths, GAP, false, -1);
  const start = GROUP_CHIP + MEMBERS_INSET;
  let previous = null;
  for (const t of FRAMES) {
    const pill = toggleFrame(closed.width, open.width, t);
    assert.ok(pill >= closed.width && pill <= open.width, `the pill stays between its closed and open widths at ${t}`);
    const frame = revealedMembers(start, open.offsets, widths, pill);
    frame.forEach((m, i) => {
      assert.equal(m.content, widths[i], `member ${i} keeps its full width inside the clip at ${t}`);
      assert.equal(m.left, start + open.offsets[i], `member ${i} doesn't move at ${t}`);
      if (i > 0) assert.ok(frame[i - 1].left + frame[i - 1].content <= m.left, `member ${i} doesn't overlap the one before it at ${t}`);
      if (previous) assert.ok(m.shown >= previous[i].shown, `member ${i} is only ever revealed more at ${t}`);
    });
    previous = frame;
  }
  assert.deepEqual(previous.map((m) => m.shown), widths, "every member is whole at the end");
});

test("opening a group decides the loose tabs once: each changes tier at most once, on the first frame, and every one stays drawn", () => {
  const before = laidOut(strip(true));
  const after = laidOut(strip(false));
  const tier = (w) => (w < TITLE_MIN_CHIP ? "favicon" : "titled");
  for (const id of loose) {
    const seen = new Set();
    for (const t of FRAMES.slice(1)) {
      const drawn = toggleFrame(before.width(id), after.width(id), t);
      seen.add(tier(after.width(id)));
      assert.ok(drawn > 0, `${id} is drawn at ${t}`);
    }
    assert.equal(seen.size, 1, `${id} keeps one tier through the open`);
  }
});

test("a group's chip width comes from its icon, its measured name and the name cap, never from how wide its pill is drawn", () => {
  const frame = 30;
  assert.equal(groupChipWidth(undefined, 40, GROUP_TITLE_MAX), undefined);
  assert.equal(groupChipWidth(frame, undefined, GROUP_TITLE_MAX), groupChipWidth(frame, undefined, GROUP_TITLE_TIGHT));
  for (const natural of [20, 79, 81, 119, 121, 300]) {
    assert.equal(groupChipWidth(frame, natural, GROUP_TITLE_MAX) - groupChipWidth(frame, natural, GROUP_TITLE_TIGHT), nameGrowth(natural));
    assert.ok(groupChipWidth(frame, natural, GROUP_TITLE_TIGHT) > frame + Math.min(natural, GROUP_TITLE_TIGHT));
  }
});
