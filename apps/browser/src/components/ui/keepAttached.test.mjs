import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const motion = await import("./motion.ts");
const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const reactNative = require.resolve("react-native-macos/package.json").replace(/package\.json$/, "");
const loaded = {
  "../../../src/private/animated/NativeAnimatedHelper": { __esModule: true, default: { API: {} } },
  "../../../src/private/animated/NativeAnimatedValidation": { validateInterpolation: () => {} },
  "../Easing": { __esModule: true, default: { linear: (t) => t } },
  invariant: (holds, message) => assert.ok(holds, message),
};

function load(name) {
  const { code } = babel.transformSync(readFileSync(`${reactNative}Libraries/Animated/nodes/${name}.js`, "utf8"), {
    babelrc: false,
    configFile: false,
    plugins: ["babel-plugin-syntax-hermes-parser", "@babel/plugin-transform-flow-strip-types", "@babel/plugin-transform-modules-commonjs"].map((p) => require.resolve(p)),
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((id) => loaded[id] ?? {}, module, module.exports);
  loaded[`./${name}`] = module.exports;
  return module.exports.default;
}

load("AnimatedNode");
load("AnimatedWithChildren");
load("AnimatedInterpolation");
const AnimatedValue = load("AnimatedValue");

function dockValue() {
  const dock = new AnimatedValue(1);
  let stops = 0;
  dock.stopAnimation = () => void stops++;
  const styled = () => dock.interpolate({ inputRange: [0, 1], outputRange: [-240, 0] });
  return { dock, styled, stops: () => stops };
}

test("React Native drops an Animated value's listeners once no style uses it", () => {
  const { dock, styled } = dockValue();
  const style = styled();
  style.__attach();
  dock.addListener(() => {});
  style.__detach();
  assert.equal(dock.hasListeners(), false);
});

test("a kept value's listeners and slide survive every style letting go, as in page full screen", () => {
  const { dock, styled, stops } = dockValue();
  const release = motion.keepAttached(dock);
  const heard = [];
  dock.addListener(({ value }) => heard.push(value));
  for (let i = 0; i < 3; i++) {
    const padding = styled(), slide = styled();
    padding.__attach();
    slide.__attach();
    padding.__detach();
    slide.__detach();
  }
  assert.equal(stops(), 0);
  dock.__callListeners(0);
  assert.deepEqual(heard, [0]);
  release();
  assert.equal(dock.hasListeners(), false);
  assert.equal(stops(), 1);
});

test("the sidebar's dock value is kept for as long as its layout lives", () => {
  const dock = readFileSync(new URL("../window/SidebarDock.tsx", import.meta.url), "utf8");
  assert.match(dock, /useInsertionEffect\(\(\) => keepAttached\(dock\), \[dock\]\);/);
});
