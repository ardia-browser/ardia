import assert from "node:assert/strict";
import { test } from "node:test";
import { barTipOwner, barTipsChanged, NO_BAR_TIPS, smallBarHint, smallBarTooltip } from "./barButton.ts";

test("a bar button's tooltip names its shortcut, and VoiceOver hears it as a hint", () => {
  assert.equal(smallBarTooltip({ tooltip: "Open as Tab", shortcut: "⌘O" }), "Open as Tab (⌘O)");
  assert.equal(smallBarTooltip({ tooltip: "Close", shortcut: "Esc" }), "Close (Esc)");
  assert.equal(smallBarTooltip({ tooltip: "Open in Split View" }), "Open in Split View");
  assert.equal(smallBarHint({ shortcut: "⌘O" }), "Shortcut: ⌘O");
  assert.equal(smallBarHint({}), undefined);
});

test("Peek's side buttons and its bar compose tooltips the same way, shortcut included", async () => {
  const { readFileSync } = await import("node:fs");
  const peek = readFileSync(new URL("../peek/PeekOverlay.tsx", import.meta.url), "utf8");
  const side = peek.slice(peek.indexOf("function PeekSideButtons"), peek.indexOf("function PeekBar"));
  assert.match(side, /tooltip=\{smallBarTooltip\(b\)\}/);
  assert.match(side, /hint=\{smallBarHint\(b\)\}/);
});

test("hovering a focused button and leaving it brings the focused button's tooltip back", () => {
  const focused = barTipsChanged(NO_BAR_TIPS, 1, "focus", true);
  assert.equal(barTipOwner(focused), 1);
  const hoveringOther = barTipsChanged(focused, 0, "hover", true);
  assert.equal(barTipOwner(hoveringOther), 0, "the hovered button shows its tooltip while the pointer is on it");
  assert.equal(barTipOwner(barTipsChanged(hoveringOther, 0, "hover", false)), 1, "leaving it restores the focused one");
  const hoveringSame = barTipsChanged(focused, 1, "hover", true);
  assert.equal(barTipOwner(barTipsChanged(hoveringSame, 1, "hover", false)), 1, "leaving the focused button keeps its tooltip");
});

test("a button's tooltip goes once it has neither hover nor focus, and a late leave from another button changes nothing", () => {
  const both = barTipsChanged(barTipsChanged(NO_BAR_TIPS, 1, "focus", true), 1, "hover", true);
  const blurred = barTipsChanged(both, 1, "focus", false);
  assert.equal(barTipOwner(blurred), 1);
  assert.equal(barTipOwner(barTipsChanged(blurred, 1, "hover", false)), null);
  const hovered = barTipsChanged(NO_BAR_TIPS, 0, "hover", true);
  assert.equal(barTipsChanged(hovered, 1, "hover", false), hovered);
  assert.equal(barTipsChanged(hovered, 0, "hover", true), hovered);
});
