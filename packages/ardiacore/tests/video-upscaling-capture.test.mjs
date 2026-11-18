import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const core = "../../../engine/ardiacore/src/ardia/core/";
const upscaling = read(`${core}ac_video_upscaling.mm`);
const upscalingHeader = read(`${core}ac_video_upscaling.h`);
const media = read(`${core}ac_tab_bridge_media.mm`);
const engine = read(`${core}ardiacore_engine.mm`);
const module = read("../ios/WebViewModule.swift");
const api = read("../src/engine/api.ts");

const body = (text, start) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  assert.fail(`${start} has no closing brace`);
};

test("the gate does not allow a tab that is sharing", () => {
  const update = body(upscaling, "void Update()");
  assert.match(update, /if \(focused && !Capturing\(focused\)\) \{\s*allowed\.insert\(focused\);/);
});

test("a tab is sharing when the capture indicator reports a tab, a window or a display share", () => {
  const sharing = body(media, "bool CapturingScreen(");
  for (const kind of ["IsCapturingTab", "IsCapturingWindow", "IsCapturingDisplay"]) {
    assert.ok(sharing.includes(`indicator_->${kind}(contents)`), `${kind} is not asked`);
  }
  assert.match(body(media, "bool IsCapturingScreen("), /CaptureObserver\(\)->CapturingScreen\(contents\)/);
  assert.match(body(upscaling, "bool Capturing("), /return IsCapturingScreen\(contents\);/);
});

test("every capture change makes the gate decide again, so a share starting or stopping is seen", () => {
  assert.match(body(media, "void Changed("), /VideoUpscalingInputsChanged\(\);/);
  for (const hook of ["OnIsCapturingTabChanged", "OnIsCapturingWindowChanged", "OnIsCapturingDisplayChanged"]) {
    assert.match(body(media, `void ${hook}(`), /Changed\(contents\);/, `${hook} does not call Changed`);
  }
});

test("the test-only capture condition and the per-tab capturing state reach the app's side", () => {
  assert.match(upscalingHeader, /std::optional<bool> capturing\);/);
  assert.match(body(upscaling, "void SetVideoUpscalingTestConditions("), /State\(\)\.test_capturing = capturing;/);
  assert.match(upscaling, /@"capturing" : @\(Capturing\(contents\)\)/);
  assert.match(engine, /conditions\[@"capturing"\]/);
  assert.match(module, /for key in \["lowPower", "thermalPressure", "capturing"\]/);
  assert.match(api, /"webView\.setVideoUpscalingTestConditions": \[\{[^}]*capturing\?: boolean[^}]*\}, null\]/);
  assert.match(api, /tabs: \{ tabId: number; allowed: boolean; capturing: boolean \}\[\]/);
});
