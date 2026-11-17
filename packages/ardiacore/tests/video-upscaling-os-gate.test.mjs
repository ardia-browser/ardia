import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const core = "../../../engine/ardiacore/src/ardia/core/";
const upscaler = read(`${core}ac_video_upscaler.mm`);
const job = read(`${core}ac_video_upscaler_job.mm`);
const kit = read(`${core}ac_video_upscaler_kit.mm`);
const internal = read(`${core}ac_video_upscaler_internal.h`);

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

const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

test("source wiring: MakePlan decides whether VideoToolbox is allowed on this OS before it asks VideoToolbox anything", () => {
  has(internal, /bool VideoToolboxBrokenOnThisOs\(\);/, "the OS check is not declared");
  const plan = body(upscaler, "std::optional<Plan> Upscaler::MakePlan(");
  const gate = plan.indexOf("VideoToolboxBrokenOnThisOs()");
  assert.ok(gate >= 0, "MakePlan does not ask whether this OS is one where VideoToolbox is broken");
  for (const touch of [
    "VTLowLatencySuperResolutionScalerConfiguration.isSupported",
    "VTLowLatencySuperResolutionScalerConfiguration.maximumDimensions",
    "supportedScaleFactorsForFrameWidth",
    "plan.vt_factor =",
  ]) {
    assert.ok(plan.indexOf(touch) > gate, `${touch} comes before the OS check`);
  }
  has(
    plan,
    /if \(!\w+ && !VideoToolboxQuarantined\(\) &&\s+VTLowLatencySuperResolutionScalerConfiguration\.isSupported/,
    "the VideoToolbox branch is not guarded by the OS check",
  );
});

test("source wiring: the OS check turns on from macOS 27 and is one named function", () => {
  const check = body(job, "bool VideoToolboxBrokenOnThisOs()");
  has(check, /if \(@available\(macOS 27\.0, \*\)\)\s*\{\s*return true;\s*\}\s*return false;/, "the check is not macOS 27 or later");
});

test("source wiring: skipping VideoToolbox for the OS leaves a trace event and falls back to the spatial scaler", () => {
  const plan = body(upscaler, "std::optional<Plan> Upscaler::MakePlan(");
  has(
    plan,
    /TRACE_EVENT_INSTANT0\("gpu", "ArdiaVSR\.VideoToolboxSkippedForOs", TRACE_EVENT_SCOPE_THREAD\);/,
    "no trace event says VideoToolbox was skipped for the OS",
  );
  has(plan, /plan\.needs_metalfx = plan\.vt_factor == 0 && plan\.rgb_size != key\.target;/, "a plan without VideoToolbox does not use MetalFX");
});

test("source wiring: a plan without a VideoToolbox factor never builds a VideoToolbox processor", () => {
  const build = body(kit, "ArdiaVideoUpscalerKit* BuildKit(");
  assert.equal((build.match(/\[\[VTFrameProcessor alloc\] init\]/g) ?? []).length, 1);
  assert.ok(body(build, "if (plan.vt_factor > 0)").includes("[[VTFrameProcessor alloc] init]"));
  assert.ok(!upscaler.includes("VTFrameProcessor alloc"));
  assert.ok(!job.includes("VTFrameProcessor alloc"));
});
