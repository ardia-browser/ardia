import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_GROUP_COLORS } from "@ardia/core";
import { folderPalette, groupBoxAtRest, groupSurface, groupTint } from "./tokens.ts";
import { GROUP_COLORS } from "../../state/groups/tokens.ts";
import { contrastRatio, mix, over } from "../../lib/color.ts";
import { withAlpha } from "../ui/tokens.ts";
import { SETTING_SPECS } from "../../state/settings/settings.ts";

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

const PROFILE = "#0A84FF";
const OTHER_PROFILE = "#C07A98";
const tray = (tint) => over(withAlpha(tint, 0.16), "#F2F2F2");

function assertOutline(stroke, tint, label) {
  assert.ok(contrastRatio(stroke, tray(tint)) >= 3, label);
  assert.equal(stroke, contrastRatio(tint, tray(tint)) >= 3 ? tint : stroke, label);
  assert.ok(contrastRatio(mix(stroke, tint, 0.2), tray(tint)) < 3 || stroke === tint, label);
}

test("a folder with no colour of its own takes the profile's colour, and a coloured one its group's tint, each darkened in light mode only as far as a 3:1 outline needs", () => {
  for (const color of [null, undefined, "none"]) {
    assertOutline(folderPalette(color, false, PROFILE).stroke, PROFILE, String(color));
    assert.deepEqual(folderPalette(color, true, PROFILE), folderPalette(null, true, PROFILE), String(color));
  }
  assert.notDeepEqual(folderPalette(null, true, PROFILE), folderPalette(null, true, OTHER_PROFILE));
  assert.notEqual(folderPalette(null, false, PROFILE).stroke, folderPalette(null, false, OTHER_PROFILE).stroke);
  for (const color of TAB_GROUP_COLORS) {
    assertOutline(folderPalette(color, false, PROFILE).stroke, GROUP_COLORS[color].hex, color);
    assert.deepEqual(folderPalette(color, false, PROFILE), folderPalette(color, false, OTHER_PROFILE), color);
    assert.deepEqual(folderPalette(color, true, PROFILE), folderPalette(color, true, OTHER_PROFILE), color);
    assert.notDeepEqual(folderPalette(color, true, PROFILE), folderPalette(null, true, PROFILE), color);
  }
});

test("folderStyle neutral draws a no-colour folder white in dark mode and grey in light mode, as in 0.2.47-nightly.6", () => {
  for (const color of [null, undefined, "none"]) {
    assert.equal(folderPalette(color, false, "#0A84FF", "neutral").stroke, "#6E6E73", String(color));
    assert.notDeepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#0A84FF"), String(color));
    assert.deepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#C07A98", "neutral"), String(color));
  }
  for (const color of TAB_GROUP_COLORS) assert.deepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#0A84FF"), color);
});

test("a live folder's service icon is its own opt-in, apart from the folder colour, and off by default", () => {
  assert.deepEqual([SETTING_SPECS.liveFolderIcon.default, SETTING_SPECS.liveFolderIcon.values], ["folder", ["folder", "service"]]);
  assert.deepEqual([SETTING_SPECS.folderStyle.default, SETTING_SPECS.folderStyle.values], ["profile", ["profile", "neutral"]]);
  for (const key of ["pressMotion", "folderStyle", "liveFolderIcon"]) assert.equal(SETTING_SPECS[key].synced, false, key);
});
