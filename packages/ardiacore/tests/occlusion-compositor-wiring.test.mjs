import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const patchName = "chromium-keep-compositor-on-occlusion.patch";
const keepOldFrame = "chromium-keep-old-frame-on-swap.patch";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const patchUrl = new URL(`../../../engine/patches/${patchName}`, import.meta.url);
const patch = existsSync(patchUrl) ? readFileSync(patchUrl, "utf8") : "";
const series = read("../../../engine/patches/series")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [kind, name, platform = "all"] = line.split(/\s+/);
    return { kind, name, platform };
  });
const patchLines = patch.split("\n");
const added = patchLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1).trim());
const removed = patchLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1).trim());
const addedText = added.join("\n");

const requirePatch = () => {
  assert.ok(patch, `an occluded window's page view still drops its compositor and last frame: ${patchName} is missing`);
};

const block = (start) => {
  const index = added.indexOf(start);
  assert.ok(index >= 0, `${patchName} does not add: ${start}`);
  return added.slice(index);
};

test("the occlusion patch is applied right after keep-old-frame, which it builds on", () => {
  requirePatch();
  const at = series.findIndex((step) => step.kind === "chromium" && step.name === keepOldFrame);
  assert.ok(at >= 0, `${keepOldFrame} is not in the series`);
  assert.deepEqual(series[at + 1], { kind: "chromium", name: patchName, platform: series[at].platform });
});

test("the occlusion patch is applied on the Mac engine only, as keep-old-frame and the Mac compositor file it edits are", () => {
  requirePatch();
  const step = series.find((entry) => entry.kind === "chromium" && entry.name === patchName);
  assert.equal(step?.platform, "mac");
  assert.ok(patch.includes("--- a/content/browser/renderer_host/browser_compositor_view_mac.mm"));
});

test("a hidden host whose view is still visible keeps its own compositor, so its last frame stays on screen", () => {
  requirePatch();
  const hold = block("if (state_ == HasOwnCompositor && root_layer_->visible() &&");
  assert.equal(hold[1], "memory_limit() >= base::MemoryLimit::NoPressureThreshold() &&");
  assert.equal(hold[2], "base::FeatureList::IsEnabled(kHoldCompositorWhileOccluded)) {");
  assert.equal(hold[3], "HoldForOcclusion();");
  assert.equal(hold[4], "return;");
  assert.equal(hold[5], "}");
  assert.ok(!addedText.includes("kUnclaimedRetiredCompositorLifetime"), "a tab switch keeps its 100 ms release");
  assert.ok(!removed.some((line) => line.includes("kUnclaimedRetiredCompositorLifetime")));
});

test("a view that really hides while its compositor is held lets the compositor go", () => {
  requirePatch();
  const release = block("if (!visible && render_widget_host_is_hidden_ &&");
  assert.equal(release[1], "state_ == HasOwnCompositor) {");
  assert.equal(release[2], "UpdateState();");
  assert.equal(release[3], "}");
  assert.ok(patch.includes("void BrowserCompositorMac::SetViewVisible(bool visible) {"));
});

test("showing a view with a held compositor embeds the renderer's surface again", () => {
  requirePatch();
  const show = block("if (was_held && !hidden && state_ == HasOwnCompositor) {");
  assert.equal(show[1], 'TRACE_EVENT_INSTANT("content", "BrowserCompositorMac::ShowHeld");');
  assert.equal(show[2], "delegated_frame_host_->WasShown(GetRendererLocalSurfaceId(), dfh_size_dip_,");
  assert.equal(show[3], "{});");
  assert.ok(addedText.replace(/\s+/g, " ").includes("const bool was_held = state_ == HasOwnCompositor && render_widget_host_is_hidden_;"));
});

test("a held compositor is let go after 10 minutes occluded, from a timer started once per hold", () => {
  requirePatch();
  assert.ok(addedText.includes('&kHoldCompositorWhileOccluded, "hold_for", base::Minutes(10)};'), "the hold lasts 10 minutes by default");
  const start = block("void BrowserCompositorMac::HoldForOcclusion() {");
  assert.deepEqual(start.slice(1, 4), ["if (held_compositor_timer_.IsRunning()) {", "return;", "}"]);
  assert.equal(start[4], 'TRACE_EVENT_INSTANT("content", "BrowserCompositorMac::HoldForOcclusion");');
  assert.equal(start[5], "held_compositor_timer_.Start(FROM_HERE,");
  assert.equal(start[6], "kHoldCompositorWhileOccludedFor.Get(), this,");
  assert.equal(start[7], "&BrowserCompositorMac::ReleaseHeldCompositor);");
  const release = block("void BrowserCompositorMac::ReleaseHeldCompositor() {");
  assert.equal(release[1], "if (state_ != HasOwnCompositor || !render_widget_host_is_hidden_) {");
  assert.equal(release[4], 'TRACE_EVENT_INSTANT("content", "BrowserCompositorMac::ReleaseHeld");');
  assert.equal(release[5], "TransitionToState(HasNoCompositor);");
});

test("the hold timer stops when the host shows again, on any real state change and on destruction", () => {
  requirePatch();
  assert.equal(added.filter((line) => line === "held_compositor_timer_.Stop();").length, 3);
  const shown = block("if (!hidden) {");
  assert.equal(shown[1], "held_compositor_timer_.Stop();");
  const transition = patchLines.findIndex((line, i) => line === "+  held_compositor_timer_.Stop();" && /if \(is_no_op\)/.test(patchLines.slice(i - 3, i).join("\n")));
  assert.ok(transition > 0, "TransitionToState stops the timer once a transition is real");
  const destroyed = patchLines.findIndex((line, i) => line === "+  held_compositor_timer_.Stop();" && patchLines[i - 1].includes("weak_factory_.InvalidateWeakPtrs();"));
  assert.ok(destroyed > 0, "the destructor stops the timer");
});

test("memory pressure lets every held compositor go and keeps new ones from being held", () => {
  requirePatch();
  assert.ok(addedText.includes("public base::MemoryConsumer {"));
  assert.ok(addedText.includes("base::MemoryConsumerRegistration memory_consumer_registration_;"));
  const registration = block("memory_consumer_registration_(");
  assert.deepEqual(registration.slice(1, 4), ['"BrowserCompositorMac",', "kHeldCompositorTraits,", "this,"]);
  assert.ok(added.includes("memory_limit() >= base::MemoryLimit::NoPressureThreshold() &&"), "no hold starts under pressure");
  const release = block("void BrowserCompositorMac::OnReleaseMemory() {");
  assert.equal(release[1], "if (memory_limit() < base::MemoryLimit::NoPressureThreshold()) {");
  assert.equal(release[2], "ReleaseHeldCompositor();");
  assert.ok(added.includes("void BrowserCompositorMac::OnUpdateMemoryLimit() {}"));
});

test("the occlusion patch holds no comments", () => {
  requirePatch();
  const comment = added.filter((line) => /^(\/\/|\/\*|\*|#(?!include ))/.test(line));
  assert.deepEqual(comment, []);
});

test("docs/engine-build.md lists the occlusion patch", () => {
  const docs = read("../../../docs/engine-build.md");
  assert.ok(docs.includes(`\`${patchName}\``), `docs/engine-build.md has no row for ${patchName}`);
});

test("docs/engine-build.md says what an occluded window keeps held", () => {
  const docs = read("../../../docs/engine-build.md");
  const row = docs.split("\n").find((line) => line.includes(`\`${patchName}\``)) ?? "";
  assert.ok(row.includes("GPU memory") && row.includes("IOSurface"), "the row does not name the memory an occluded window holds");
  assert.ok(/10 minutes/.test(row) && /memory pressure/.test(row), "the row does not say when the memory is given back");
});
