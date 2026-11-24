import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const phone = path.resolve(import.meta.dirname, "../..");
const config = require(path.join(phone, "metro.config.js"));
const recycling = path.join(phone, "node_modules", "@expo", "ui", "build", "recycling", "useRecycledRows.js");
const passedOn = { type: "passed-on" };
const context = (origin: string) => ({ originModulePath: origin, resolveRequest: () => passedOn });

test("iPhone bundles take the stepped row window in place of Expo UI's, and only from its recycling module", () => {
  const resolve = config.resolver.resolveRequest;
  assert.deepEqual(resolve(context(recycling), "./window", "ios"), { type: "sourceFile", filePath: path.join(phone, "src", "lib", "steppedWindow.ts") });
  assert.equal(resolve(context(recycling), "./window", "android"), passedOn);
  assert.equal(resolve(context(path.join(phone, "src", "App.tsx")), "./window", "ios"), passedOn);
});

test("Expo UI still has the window module the iPhone build replaces", () => {
  const upstream = require(path.join(phone, "node_modules", "@expo", "ui", "build", "recycling", "window.js"));
  assert.equal(typeof upstream.getWindow, "function");
  assert.equal(typeof upstream.getSlotIndices, "function");
});

test("phone bundles inline their requires, so a module loads when it is first used rather than at launch", async () => {
  const options = await config.transformer.getTransformOptions([], { dev: false, hot: false, platform: "ios" }, async () => []);
  assert.deepEqual(options.transform, { experimentalImportSupport: true, inlineRequires: true });
});
