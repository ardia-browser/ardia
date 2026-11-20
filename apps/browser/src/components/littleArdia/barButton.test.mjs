import assert from "node:assert/strict";
import { test } from "node:test";
import { smallBarHint, smallBarTooltip } from "./barButton.ts";

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
