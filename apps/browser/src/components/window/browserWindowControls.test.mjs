import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the window's own buttons mount nothing where the system draws them, and the placed controls where the app draws them", () => {
  const controls = readFileSync(new URL("./BrowserWindowControls.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(controls, /export const browserWindowControls = \(\) =>\s+controlsShown \? \(\s+<>\s+<PlacedControls \/>\s+<PlacedLeadingControls \/>\s+<\/>\s+\) : null;/);
  assert.match(app, /\{browserWindowControls\(\)\}/);
  assert.doesNotMatch(app, /<BrowserWindowControls/);
});

test("where the window buttons can be chosen the placed controls mount whatever style the window started with, and the buttons themselves follow the live style", () => {
  const controls = readFileSync(new URL("./WindowControls.tsx", import.meta.url), "utf8");
  assert.match(controls, /export const controlsShown = windowControlsDrawn\(\) \|\| windowButtonsChoosable;/);
  assert.match(controls, /const shown = useControlsShown\(\);\n.*\n  if \(!shown \|\| !drawn\.length\) return null;/);
});
