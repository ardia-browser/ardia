import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_GROUP_COLORS } from "@ardia/core";
import { FOLDER_OUTLINE_CONTRAST, folderPalette, groupBoxAtRest, groupSurface, groupTint } from "./tokens.ts";
import { PROFILE_COLORS, profileTheme } from "../ui/theme.ts";
import { contrastRatio, luminance } from "../../lib/color.ts";
import { hexColor, oklab } from "../../lib/profileLook.ts";
import { GROUP_COLORS } from "../../state/groups/tokens.ts";
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

const pastelTheme = (hex, mode = "auto") => ({ stops: [{ color: hexColor(hex), x: 0.5, y: 0.5 }], intensity: 0.8, grain: 0, texture: "grain", translucency: 0, mode });

const FOLDER_PROFILES = [
  ...Object.keys(PROFILE_COLORS).map((color) => ({ color })),
  ...["#6DC4FC", "#BFD9F2", "#FFF59D", "#F7C8E0", "#1B2A5C", "#7A1020"].map((hex) => ({ color: "blue", theme: pastelTheme(hex) })),
  ...["light", "dark"].map((mode) => ({ color: "blue", theme: pastelTheme("#999999", mode) })),
];

const hue = (hex) => {
  const [, a, b] = oklab(hexColor(hex));
  return Math.atan2(b, a);
};

const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

test("a folder's outline stands out from the sidebar behind it in every profile colour and appearance", () => {
  for (const profile of FOLDER_PROFILES) {
    for (const appDark of [false, true]) {
      const theme = profileTheme(profile, appDark);
      const tint = theme.powerUpColor ?? theme.accent;
      for (const color of [null, ...TAB_GROUP_COLORS]) {
        const { stroke } = folderPalette(color, theme.dark, tint, "profile", theme.windowTint);
        const worst = Math.min(...theme.windowTint.map((backdrop) => contrastRatio(stroke, backdrop)));
        assert.ok(worst >= FOLDER_OUTLINE_CONTRAST, `${profile.theme ? profile.theme.stops[0].color.r : profile.color} ${appDark} ${color}: ${stroke} on ${theme.windowTint} is ${worst.toFixed(2)}`);
      }
    }
  }
});

test("a folder with no colour of its own is drawn in the profile's colour, a darker outline round a lighter fill of it", () => {
  const SKY = "#6DC4FC";
  for (const color of [null, undefined, "none"]) {
    const light = folderPalette(color, false, SKY, "profile", [SKY]);
    assert.ok(hueGap(light.stroke, SKY) < 0.2, `${String(color)} ${light.stroke}`);
    assert.ok(hueGap(light.face, SKY) < 0.2, `${String(color)} ${light.face}`);
    assert.ok(luminance(light.stroke) < luminance(SKY) && luminance(light.face) > luminance(SKY), String(color));
    assert.notEqual(light.face, "#FFFFFF");
    assert.deepEqual(folderPalette(color, true, SKY), folderPalette(null, true, SKY), String(color));
  }
  assert.notDeepEqual(folderPalette(null, true, "#0A84FF"), folderPalette(null, true, "#C07A98"));
  for (const dark of [false, true]) {
    const { stroke, face, insideTop, insideBottom } = folderPalette(null, dark, "#4691C3", "profile", []);
    const order = [face, insideTop, insideBottom, stroke].map(luminance);
    for (let i = 1; i < order.length; i++) assert.ok(dark ? order[i] > order[i - 1] || i === 2 : order[i] < order[i - 1], `${dark} ${order}`);
  }
});

test("a folder with its own colour gets the same treatment in its group's tint, whatever the profile", () => {
  for (const color of TAB_GROUP_COLORS) {
    const hex = GROUP_COLORS[color].hex;
    for (const dark of [false, true]) {
      assert.deepEqual(folderPalette(color, dark, "#0A84FF"), folderPalette(color, dark, "#C07A98"), color);
      assert.notDeepEqual(folderPalette(color, dark, "#0A84FF"), folderPalette(null, dark, "#0A84FF"), color);
    }
    if (color !== "grey") assert.ok(hueGap(folderPalette(color, false, "#0A84FF").stroke, hex) < 0.25, color);
  }
});

test("over a two-colour sidebar, a folder's outline finds the mid tone that stands out from both colours when one exists", () => {
  const grey = (v) => "#" + v.toString(16).padStart(2, "0").repeat(3);
  const worst = (color, backdrops) => Math.min(...backdrops.map((backdrop) => contrastRatio(color, backdrop)));
  const navy = "#1B2A5C";
  for (const dark of [false, true]) {
    for (const backdrops of [["#000000", "#E1E1E1"], ["#000000", "#8D8D8D"], ["#060606", "#C0C0C0"]]) {
      const { stroke } = folderPalette(null, dark, navy, "profile", backdrops);
      assert.ok(worst(stroke, backdrops) >= FOLDER_OUTLINE_CONTRAST, `${dark}: ${stroke} on ${backdrops} is ${worst(stroke, backdrops).toFixed(2)}`);
    }
  }
  for (const tint of [navy, "#6DC4FC", "#999999", "#E0457B", "#FFF59D"]) {
    for (const dark of [false, true]) {
      for (let a = 0; a <= 255; a += 15) {
        for (let b = a; b <= 255; b += 15) {
          const backdrops = [grey(a), grey(b)];
          let reachable = false;
          for (let v = 0; v <= 255 && !reachable; v++) reachable = worst(grey(v), backdrops) >= FOLDER_OUTLINE_CONTRAST;
          if (!reachable) continue;
          const { stroke } = folderPalette(null, dark, tint, "profile", backdrops);
          assert.ok(worst(stroke, backdrops) >= FOLDER_OUTLINE_CONTRAST, `${tint} ${dark} on ${backdrops}: ${stroke} is ${worst(stroke, backdrops).toFixed(2)}`);
        }
      }
    }
  }
});

test("folderStyle neutral draws a no-colour folder white in dark mode and grey in light mode, as in 0.2.47-nightly.6", () => {
  for (const color of [null, undefined, "none"]) {
    assert.equal(folderPalette(color, false, "#0A84FF", "neutral").stroke, "#6E6E73", String(color));
    assert.equal(folderPalette(color, true, "#0A84FF", "neutral").stroke, "#FFFFFF", String(color));
    assert.notDeepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#0A84FF"), String(color));
    assert.deepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#C07A98", "neutral"), String(color));
  }
  for (const color of TAB_GROUP_COLORS) assert.deepEqual(folderPalette(color, true, "#0A84FF", "neutral"), folderPalette(color, true, "#0A84FF"), color);
});

test("folderStyle neutral keeps nightly.6's no-colour folder over any sidebar, while group colours still meet the outline contrast", () => {
  const nightly6 = {
    light: { stroke: "#6E6E73", face: "#F6F6F7", insideTop: "#CECECF", insideBottom: "#A2A2A5" },
    dark: { stroke: "#FFFFFF", face: "#3C3943", insideTop: "#7A787F", insideBottom: "#4D4B54" },
  };
  for (const profile of FOLDER_PROFILES) {
    for (const appDark of [false, true]) {
      const theme = profileTheme(profile, appDark);
      const tint = theme.powerUpColor ?? theme.accent;
      assert.deepEqual(folderPalette(null, theme.dark, tint, "neutral", theme.windowTint), nightly6[theme.dark ? "dark" : "light"], `${theme.windowTint}`);
      for (const color of TAB_GROUP_COLORS) {
        const { stroke } = folderPalette(color, theme.dark, tint, "neutral", theme.windowTint);
        const worst = Math.min(...theme.windowTint.map((backdrop) => contrastRatio(stroke, backdrop)));
        assert.ok(worst >= FOLDER_OUTLINE_CONTRAST, `${color} on ${theme.windowTint}: ${stroke} is ${worst.toFixed(2)}`);
      }
    }
  }
});

test("a live folder's service icon is its own opt-in, apart from the folder colour, and off by default", () => {
  assert.deepEqual([SETTING_SPECS.liveFolderIcon.default, SETTING_SPECS.liveFolderIcon.values], ["folder", ["folder", "service"]]);
  assert.deepEqual([SETTING_SPECS.folderStyle.default, SETTING_SPECS.folderStyle.values], ["profile", ["profile", "neutral"]]);
  for (const key of ["pressMotion", "folderStyle", "liveFolderIcon"]) assert.equal(SETTING_SPECS[key].synced, false, key);
});
