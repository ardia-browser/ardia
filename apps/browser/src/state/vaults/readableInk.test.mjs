import assert from "node:assert/strict";
import { test } from "node:test";
const { readableInk, groupGround, READABLE_TEXT } = await import("./readableInk.ts");
const { contrastRatio } = await import("../../lib/color.ts");

const LIGHT = { warning: "#FF9500", groupFill: "rgba(0,0,0,0.028)", pane: "#F2F2F2", text: "#000000" };
const DARK = { warning: "#FF9F0A", groupFill: "rgba(255,255,255,0.045)", pane: "#1E1E1E", text: "#FFFFFF" };

test("amber status text darkens in light until it reads at 4.5:1 on the group, and stays amber in dark where it already does", () => {
  const lightGround = groupGround(LIGHT.groupFill, LIGHT.pane);
  assert.ok(contrastRatio(LIGHT.warning, lightGround) < 2.5, "the system amber is too faint on a light group");
  const light = readableInk(LIGHT.warning, lightGround, LIGHT.text);
  assert.ok(contrastRatio(light, lightGround) >= READABLE_TEXT);
  assert.notEqual(light, LIGHT.text, "it stays a warm amber, not black");
  const darkGround = groupGround(DARK.groupFill, DARK.pane);
  assert.equal(readableInk(DARK.warning, darkGround, DARK.text), DARK.warning);
});
