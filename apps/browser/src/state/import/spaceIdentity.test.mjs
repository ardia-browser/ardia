import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { adoptSpaceIdentity } = await import("./apply.ts");

const S = () => useBrowser.getState();
const BLUE = { stops: [{ x: 0.3, y: 0.6, color: { r: 0.2, g: 0.4, b: 0.7, a: 1 } }], intensity: 0.7, mode: "auto", grain: 0, texture: "grain", translucency: 1 };

test("taking an imported space's colour brings back that preset's edit instead of showing it plain", () => {
  S().hydrate({});
  const id = S().settings.defaultProfileId;
  S().setProfileLook(id, { presetThemes: { blue: BLUE } });
  assert.ok(adoptSpaceIdentity(id, { name: "Work", color: "#4691C3" }));
  assert.equal(S().profiles[id].color, "blue");
  assert.deepEqual(S().profiles[id].theme, BLUE);
  assert.deepEqual(S().profiles[id].presetThemes, { blue: BLUE }, "and it stays this Mac's own look of blue");
});
