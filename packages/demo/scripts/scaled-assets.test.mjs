import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundledImages, scaledBrowserAssets } from "../../../apps/desktop/scripts/scaledAssetsBundle.mjs";

test("the demo build bundles the Retina siblings instead of the 1x PNGs", { timeout: 120_000 }, async () => {
  const { holds } = await bundledImages(fileURLToPath(new URL("../", import.meta.url)));
  const scaled = scaledBrowserAssets();
  assert.equal(scaled.length, 38);
  for (const entry of scaled) {
    assert.ok(holds(entry.file), `${entry.file} is missing from the demo build`);
    assert.ok(!holds(entry.base), `${entry.base} still ships in the demo build`);
  }
});
