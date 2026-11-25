import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;

test("Reanimated never re-renders settled animations through React, so a deck open redraws no card on Android once it has settled", () => {
  const defaults = json("../../node_modules/react-native-reanimated/src/featureFlags/staticFlags.json");
  assert.ok("FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS" in defaults);
  const app = json("../../package.json") as { reanimated?: { staticFeatureFlags?: Record<string, boolean> } };
  assert.equal(app.reanimated?.staticFeatureFlags?.FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS, false);
});

test("on Android Reanimated applies animated props straight to the views, so a deck scroll doesn't commit every card's style through Fabric", () => {
  const defaults = json("../../node_modules/react-native-reanimated/src/featureFlags/staticFlags.json");
  assert.ok("ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS" in defaults);
  const app = json("../../package.json") as { reanimated?: { staticFeatureFlags?: Record<string, boolean> } };
  assert.equal(app.reanimated?.staticFeatureFlags?.ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS, true);
});

test("on iPhone Reanimated applies transform, opacity and colour props straight to the views, so a deck scroll doesn't commit every card's style through Fabric", () => {
  const defaults = json("../../node_modules/react-native-reanimated/src/featureFlags/staticFlags.json");
  assert.ok("IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS" in defaults);
  const app = json("../../package.json") as { reanimated?: { staticFeatureFlags?: Record<string, boolean> } };
  assert.equal(app.reanimated?.staticFeatureFlags?.IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS, true);
});
