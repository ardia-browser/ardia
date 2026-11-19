import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const patchName = "chromium-media-controls-pinch-width.patch";
const layoutMedia = "third_party/blink/renderer/core/layout/layout_media.cc";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const patchUrl = new URL(`../../../engine/patches/${patchName}`, import.meta.url);
const patch = existsSync(patchUrl) ? readFileSync(patchUrl, "utf8") : "";
const patchLines = patch.split("\n");
const added = patchLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1).trim());
const removed = patchLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1).trim());
const series = read("../../../engine/patches/series")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [kind, name, platform = "all"] = line.split(/\s+/);
    return { kind, name, platform };
  });

const requirePatch = () => {
  assert.ok(patch, `a video's controls shrink after a pinch zoom on a page with overflow-x hidden or clip: ${patchName} is missing`);
};

test("the patch edits only LayoutMedia, where the controls panel's width is decided", () => {
  requirePatch();
  const files = patchLines.filter((line) => line.startsWith("--- a/")).map((line) => line.slice("--- a/".length));
  assert.deepEqual(files, [layoutMedia]);
});

test("the panel is cut against the layout viewport's visible width, which a pinch zoom does not change", () => {
  requirePatch();
  assert.ok(added.includes("const PaintLayerScrollableArea* layout_viewport = page_view->LayoutViewport();"));
  assert.ok(added.includes("const LayoutUnit visible_width(layout_viewport->VisibleWidth());"));
  assert.ok(added.includes('#include "third_party/blink/renderer/core/paint/paint_layer_scrollable_area.h"'));
});

test("the pinch-scaled visual viewport's width no longer decides it", () => {
  requirePatch();
  assert.ok(removed.includes("const LayoutUnit visible_width(page->GetVisualViewport().VisibleWidth());"));
  assert.ok(!added.some((line) => line.includes("GetVisualViewport")));
});

test("with no layout viewport the panel keeps the video's whole width, as every other early return does", () => {
  requirePatch();
  const at = added.indexOf("const PaintLayerScrollableArea* layout_viewport = page_view->LayoutViewport();");
  assert.deepEqual(added.slice(at + 1, at + 3), ["if (!layout_viewport)", "return media_rect.Width();"]);
});

test("the corner tests and the shortening they feed are left as they were, so crbug.com/771379's case still works", () => {
  requirePatch();
  assert.ok(!removed.some((line) => /bottom_(left|right)_(point|corner_visible)|panel_width/.test(line)));
  assert.ok(!added.some((line) => /bottom_(left|right)_(point|corner_visible)/.test(line)));
});

test("the patch adds no comments to Blink", () => {
  requirePatch();
  assert.deepEqual(
    added.filter((line) => /^(\/\/|\/\*|\*)/.test(line)),
    [],
  );
});

test("the patch is applied on every engine, as Blink's layout code is shared", () => {
  requirePatch();
  const steps = series.filter((entry) => entry.kind === "chromium" && entry.name === patchName);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].platform, "all");
});

test("docs/engine-build.md lists the patch and says what it fixes", () => {
  const docs = read("../../../docs/engine-build.md");
  const row = docs.split("\n").find((line) => line.includes(`\`${patchName}\``)) ?? "";
  assert.ok(row, `docs/engine-build.md has no row for ${patchName}`);
  assert.ok(/pinch/.test(row) && /layout viewport/.test(row), "the row does not say the panel is compared with the layout viewport after a pinch");
});

test("docs/engine-build-windows.md lists the patch as applying to Windows", () => {
  const docs = read("../../../docs/engine-build-windows.md");
  const row = docs.split("\n").find((line) => line.includes(`\`${patchName}\``)) ?? "";
  assert.ok(row, `docs/engine-build-windows.md has no row for ${patchName}`);
  assert.ok(row.includes("applies") && row.includes("OS-neutral"));
});

test("the Windows engine's accepted patch list names the patch", () => {
  const accepted = read("../../../scripts/windows/engine/accepted-patches.txt")
    .split("\n")
    .map((line) => line.trim());
  assert.ok(accepted.includes(patchName), `accepted-patches.txt does not list ${patchName}`);
});
