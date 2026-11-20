import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the window's own buttons mount nothing where the system draws them, and the placed controls where the app draws them", () => {
  const controls = readFileSync(new URL("./BrowserWindowControls.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(controls, /export const browserWindowControls = \(\) => \(controlsShown \? <PlacedControls \/> : null\);/);
  assert.match(app, /\{browserWindowControls\(\)\}/);
  assert.doesNotMatch(app, /<BrowserWindowControls/);
});
