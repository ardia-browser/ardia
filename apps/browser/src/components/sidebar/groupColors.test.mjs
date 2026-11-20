import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_GROUP_COLORS } from "@ardia/core";
import { folderPalette, groupBoxAtRest, groupSurface, groupTint } from "./tokens.ts";
import { GROUP_COLORS } from "../../state/groups/tokens.ts";
import { contrastRatio, mix, over } from "../../lib/color.ts";
import { withAlpha } from "../ui/tokens.ts";

const TOKENS = { groupFill: "rgba(255,255,255,0.1)", groupStroke: "rgba(255,255,255,0.1)" };

test("every colour a group can take draws its box at rest, in its own tint", () => {
  for (const color of TAB_GROUP_COLORS) {
    assert.ok(GROUP_COLORS[color], color);
    assert.equal(groupTint(color), GROUP_COLORS[color].hex, color);
    assert.equal(groupBoxAtRest(color), true, color);
    assert.notDeepEqual(groupSurface(color, TOKENS), { fill: TOKENS.groupFill, stroke: TOKENS.groupStroke }, color);
  }
});

test("a neutral group keeps Dia's look, its box only under the pointer, and None never draws one", () => {
  assert.equal(groupBoxAtRest(null), false);
  assert.equal(groupBoxAtRest(undefined), false);
  assert.equal(groupBoxAtRest("none"), false);
  assert.deepEqual(groupSurface(null, TOKENS), { fill: TOKENS.groupFill, stroke: TOKENS.groupStroke });
  assert.deepEqual(groupSurface("none", TOKENS), { fill: "transparent", stroke: "transparent" });
});

test("a folder with no colour of its own is drawn in #443AFF, and a coloured one in its group's tint, darkened in light mode only as far as a 3:1 outline needs", () => {
  for (const color of [null, undefined, "none"]) {
    assert.equal(folderPalette(color, false).stroke, "#443AFF", String(color));
    assert.deepEqual(folderPalette(color, true), folderPalette(null, true), String(color));
  }
  for (const color of TAB_GROUP_COLORS) {
    const tint = GROUP_COLORS[color].hex;
    const tray = over(withAlpha(tint, 0.16), "#F2F2F2");
    const stroke = folderPalette(color, false).stroke;
    assert.ok(contrastRatio(stroke, tray) >= 3, color);
    assert.equal(stroke, contrastRatio(tint, tray) >= 3 ? tint : stroke, color);
    assert.ok(contrastRatio(mix(stroke, tint, 0.2), tray) < 3 || stroke === tint, color);
    assert.notDeepEqual(folderPalette(color, true), folderPalette(null, true), color);
  }
});
