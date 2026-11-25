import assert from "node:assert/strict";
import { test } from "node:test";
const { lookFor } = await import("./look.ts");
const { mergedPalettes } = await import("../../../lib/themeFile.ts");
const { colorRoles, PROFILE_COLORS } = await import("../../ui/tokens.ts");
const { parseColor } = await import("../../../lib/color.ts");

test("onboarding previews draw with the effective palette and rebuild when its revision changes", () => {
  const plum = PROFILE_COLORS.plum.swatch;
  assert.equal(lookFor(true, plum, null).t.panel, colorRoles.dark.panel);
  const nord = mergedPalettes(colorRoles, { dark: { panel: "#2E3440" }, light: {} }, 1);
  assert.equal(lookFor(true, plum, nord).t.panel, "#2E3440");
  assert.equal(lookFor(true, plum, nord), lookFor(true, plum, nord));
  const red = mergedPalettes(colorRoles, { dark: { panel: "#BF616A" }, light: {} }, 2);
  assert.equal(lookFor(true, plum, red).t.panel, "#BF616A");
  assert.equal(lookFor(true, plum, null).t.panel, colorRoles.dark.panel);
});

test("the preview's sidebar draws the real window's gradient for each preset, not a wallpaper-tinted brown", () => {
  const realWindow = {
    dark: { plum: ["#423235", "#494143"], blue: ["#323C42", "#414649"], green: ["#32423C", "#414946"], orange: ["#423732", "#494441"], neutral: ["#2F2F2F", "#323232"] },
    light: { plum: ["#E4CDD1", "#EEE3E5"], blue: ["#CDDBE4", "#E3EAEE"], neutral: ["#ECECEC", "#F2F2F2"] },
  };
  for (const [mode, presets] of Object.entries(realWindow)) {
    for (const [color, ends] of Object.entries(presets)) {
      const tint = lookFor(mode === "dark", PROFILE_COLORS[color].swatch, null).tint;
      ends.forEach((expected, i) => {
        const drawn = parseColor(tint[i]);
        parseColor(expected).slice(0, 3).forEach((v, c) => assert.ok(Math.abs(drawn[c] - v) <= 2, `${mode} ${color} ${i ? "bottom" : "top"}: ${tint[i]} vs ${expected}`));
      });
    }
  }
});
