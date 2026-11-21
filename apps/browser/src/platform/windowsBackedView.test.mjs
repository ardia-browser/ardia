import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { backedStyles, FILL_Z_INDEX, nativePaint, processedColorDraws } = await import("../../../../packages/expo-windows/src/views/backgroundFill.ts");
const { backedOnWindows, backedView, rawView } = createRequire(import.meta.url)("../../../../packages/expo-windows/metroResolution.js");

const at = (offsets, extra = {}) => ({ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, ...offsets, zIndex: FILL_Z_INDEX, backgroundColor: "red", ...extra });

test("no fill without a background that draws, so the view is left as it is", () => {
  assert.equal(backedStyles(undefined), null);
  assert.equal(backedStyles({}), null);
  assert.equal(backedStyles({ backgroundColor: "transparent", borderRadius: 8 }), null);
  assert.equal(backedStyles({ backgroundColor: "rgba(0,0,0,0)" }, (color) => color !== "rgba(0,0,0,0)"), null);
});

test("a colour draws when its alpha byte isn't zero, as React Native Windows decides, whatever its other channels", () => {
  assert.equal(processedColorDraws(0xff0000ff), true);
  assert.equal(processedColorDraws(0x01000000), true);
  assert.equal(processedColorDraws(0x00ff0000), false);
  assert.equal(processedColorDraws(0), false);
  assert.equal(processedColorDraws(null), false);
  assert.equal(processedColorDraws({ windowsbrush: ["SystemAccentColor"] }), true);
});

test("the fill takes the background off the view and keeps everything else on it, the shadow included", () => {
  const backed = backedStyles({ backgroundColor: "red", opacity: 0.5, transform: [{ scale: 2 }], zIndex: 3, padding: 4, shadowColor: "black", shadowOpacity: 0.2 });
  assert.deepEqual(backed.fill, at({}));
  assert.deepEqual(backed.own, { opacity: 0.5, transform: [{ scale: 2 }], zIndex: 3, padding: 4, shadowColor: "black", shadowOpacity: 0.2 });
});

test("the fill has the lowest zIndex, so Fabric mounts it before a static child or one with a negative zIndex", () => {
  assert.equal(backedStyles({ backgroundColor: "red" }).fill.zIndex, -(2 ** 31));
});

test("the fill covers the border box and draws the border, as React Native Windows paints a background under the border", () => {
  const backed = backedStyles({ backgroundColor: "red", borderWidth: 1, borderColor: "rgba(0,0,0,0.1)", borderRadius: 10, borderStyle: "dashed", borderCurve: "continuous" });
  assert.deepEqual(backed.fill, at({ top: -1, bottom: -1, left: -1, right: -1 }, { borderWidth: 1, borderColor: "rgba(0,0,0,0.1)", borderRadius: 10, borderStyle: "dashed", borderCurve: "continuous" }));
  assert.deepEqual(backed.own, { borderWidth: 1, borderRadius: 10, borderStyle: "dashed", borderCurve: "continuous", borderColor: "transparent" });
});

test("each side reaches out by its own border width, start and end winning over left and right as Yoga reads them", () => {
  const backed = backedStyles({ backgroundColor: "red", borderWidth: 2, borderTopWidth: 3, borderLeftWidth: 5, borderStartWidth: 4, borderRightColor: "blue" });
  assert.deepEqual([backed.fill.top, backed.fill.bottom, backed.fill.left, backed.fill.right], [-3, -2, -4, -2]);
  assert.equal(backed.fill.borderRightColor, "blue");
  assert.equal(backed.own.borderRightColor, undefined);
  assert.equal(backed.own.borderColor, "transparent");
});

test("a percentage radius passes through, and a borderless view gets no clear border colour", () => {
  const backed = backedStyles({ backgroundColor: "red", borderRadius: "50%" });
  assert.equal(backed.fill.borderRadius, "50%");
  assert.equal(backed.own.borderColor, undefined);
});

test("setNativeProps paint goes to the fill: background and border colours only there, radius, curve and style to both", () => {
  assert.equal(nativePaint(undefined), null);
  assert.equal(nativePaint({ opacity: 0.3, transform: [{ scale: 2 }] }), null);
  assert.deepEqual(nativePaint({ backgroundColor: undefined, borderColor: undefined }), { fill: { backgroundColor: null, borderColor: null }, own: {} });
  assert.deepEqual(nativePaint({ borderRadius: undefined }), { fill: { borderRadius: null }, own: { borderRadius: null } });
  assert.deepEqual(nativePaint({ backgroundColor: "blue", opacity: 0.4 }), { fill: { backgroundColor: "blue" }, own: { opacity: 0.4 } });
  assert.deepEqual(nativePaint({ backgroundColor: "transparent" }), { fill: { backgroundColor: "transparent" }, own: {} });
  assert.deepEqual(nativePaint({ borderRadius: 12, borderTopColor: "red", borderStyle: "dotted", borderWidth: 2 }), { fill: { borderRadius: 12, borderTopColor: "red", borderStyle: "dotted" }, own: { borderRadius: 12, borderStyle: "dotted", borderWidth: 2 } });
});

test("Metro hands every importer of React Native Windows' View the backed view, except the raw view's own module", () => {
  const view = path.join("/repo", "node_modules", ".pnpm", "react-native-windows@0.81.38", "node_modules", "react-native-windows", "Libraries", "Components", "View", "View.windows.js");
  const other = { type: "sourceFile", filePath: path.join(path.dirname(view), "ViewNativeComponent.js") };
  assert.deepEqual(backedOnWindows({ type: "sourceFile", filePath: view }, "/repo/node_modules/react-native-windows/Libraries/Components/Pressable/Pressable.js"), { type: "sourceFile", filePath: backedView });
  assert.deepEqual(backedOnWindows({ type: "sourceFile", filePath: view.replaceAll("/", "\\") }, "C:\\a\\b.js"), { type: "sourceFile", filePath: backedView });
  assert.deepEqual(backedOnWindows({ type: "sourceFile", filePath: view }, rawView), { type: "sourceFile", filePath: view });
  assert.deepEqual(backedOnWindows(other, "/repo/x.js"), other);
  assert.deepEqual(backedOnWindows({ type: "empty" }, "/repo/x.js"), { type: "empty" });
});

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const packageSources = readdirSync(path.join(repo, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(repo, "packages", entry.name, "src"));

function* sources(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) yield full;
  }
}

test("no shared view is static, right to left or outlined, which an absolute fill at the border box can't match", () => {
  const offending = [];
  for (const dir of [path.join(repo, "apps/browser/src"), ...packageSources]) {
    for (const file of sources(dir)) {
      if (/position:\s*["']static["']|direction:\s*["']rtl["']|forceRTL|outline(Width|Offset|Color|Style)\s*:/.test(readFileSync(file, "utf8"))) offending.push(path.relative(repo, file));
    }
  }
  assert.deepEqual(offending, []);
});
