import assert from "node:assert/strict";
import { test } from "node:test";

const { DeviceEventEmitter, turboModules } = await import("../test-native/reactNative.ts");
const MODULE = new URL("../../../../packages/expo-windows/src/views/materialCapabilities.ts", import.meta.url).href;
let cases = 0;

async function freshModule({ draws = true } = {}) {
  const native = { gradient: draws };
  turboModules.ArdiaMaterials = {
    capabilities: () => ({ build: 22631, systemBackdrop: true, systemBackdropSupported: true, inWindowBlur: true, gradient: native.gradient, background: true }),
  };
  const capabilities = await import(`${MODULE}?case=${++cases}`);
  const brushFails = () => {
    native.gradient = false;
    DeviceEventEmitter.emit(capabilities.GRADIENT_FAILED_EVENT, {});
  };
  return { native, capabilities, brushFails };
}

test("while the native brush draws, a mounted layer hears nothing and keeps drawing", async () => {
  const { capabilities } = await freshModule();
  let switched = 0;
  const stop = capabilities.followGradientFailure(() => switched++);
  assert.equal(capabilities.gradientDrawsNow(), true);
  assert.equal(switched, 0);
  stop();
});

test("reproduction: without the native report, the cached answer stays true after the brush fails", async () => {
  const { native, capabilities } = await freshModule();
  assert.equal(capabilities.nativeGradient(), true, "the first answer is cached");
  native.gradient = false;
  assert.equal(capabilities.nativeGradient(), true, "what GradientLayer read before #1877, so it kept an empty native view");
});

test("a brush that fails at any later moment switches every mounted layer to the stripes and corrects the cache", async () => {
  const { capabilities, brushFails } = await freshModule();
  const told = [];
  const first = capabilities.followGradientFailure(() => told.push("first"));
  const second = capabilities.followGradientFailure(() => told.push("second"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(told, [], "nothing before the failure");
  brushFails();
  assert.deepEqual(told, ["first", "second"], "both layers switch when native reports it, however late");
  assert.equal(capabilities.nativeGradient(), false, "and every later gradient starts striped");
  first();
  second();
});

test("a brush that fails between the layer's first render and its subscription still switches it, though nobody heard the event", async () => {
  const { capabilities, brushFails } = await freshModule();
  assert.equal(capabilities.gradientDrawsNow(), true, "the layer's first render chose the native gradient");
  brushFails();
  let switched = 0;
  const stop = capabilities.followGradientFailure(() => switched++);
  assert.equal(switched, 1, "the ask right after subscribing catches it");
  DeviceEventEmitter.emit(capabilities.GRADIENT_FAILED_EVENT, {});
  assert.equal(switched, 2, "and the layer stays subscribed for anything after");
  stop();
});

test("a layer that unmounts first is told nothing when a brush fails later", async () => {
  const { capabilities, brushFails } = await freshModule();
  let told = 0;
  const stop = capabilities.followGradientFailure(() => told++);
  stop();
  const keeper = capabilities.followGradientFailure(() => {});
  brushFails();
  assert.equal(told, 0);
  keeper();
});

test("a layer that mounts after a failure starts striped without waiting for an event", async () => {
  const { capabilities } = await freshModule({ draws: false });
  assert.equal(capabilities.gradientDrawsNow(), false);
  let switched = 0;
  const stop = capabilities.followGradientFailure(() => switched++);
  assert.equal(switched, 1);
  stop();
});

test("each case starts from its own module, so their order doesn't matter", async () => {
  const failed = await freshModule();
  failed.brushFails();
  assert.equal(failed.capabilities.gradientDrawsNow(), false);
  const next = await freshModule();
  assert.equal(next.capabilities.nativeGradient(), true, "a fresh module asks native again instead of keeping the last answer");
});
