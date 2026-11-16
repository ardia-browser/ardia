import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fallbackColumns, fallbackRows, flatColors, gradientFill } from "../../../../packages/expo-windows/src/views/gradientFill.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a Surface's fill colours become positioned stops, with the fade passed through", () => {
  const filled = gradientFill({ fillColors: ["#ff000000", "#ff000080", "#ff0000ff"], fillStops: [0, 0.4, 1], fade: [1, 0.5, 0], fadeStops: [0, 0.8, 1] });
  assert.deepEqual(filled.stops, [[1, 0, 0, 0], [1, 0, 0, 128 / 255], [1, 0, 0, 1]]);
  assert.deepEqual(filled.places, [0, 0.4, 1]);
  assert.deepEqual(filled.fade, [1, 0.5, 0]);
  assert.deepEqual(filled.fadePlaces, [0, 0.8, 1]);
  assert.deepEqual(flatColors(filled.stops), [1, 0, 0, 0, 1, 0, 0, 128 / 255, 1, 0, 0, 1]);
});

test("stops that don't match their colours are spaced evenly, as the Mac's CAGradientLayer does with nil locations", () => {
  const filled = gradientFill({ fillColors: ["#000", "#fff"], fillStops: [0, 0.5, 1], fade: [1, 0], fadeStops: [0.2] });
  assert.equal(filled.places, undefined);
  assert.equal(filled.fadePlaces, undefined);
  assert.deepEqual(filled.fade, [1, 0]);
});

test("a solid fill fades too, as the Mac masks the whole plate; no gradient without two colours or a fade", () => {
  assert.deepEqual(gradientFill({ fill: "#00ff00", fade: [1, 0] }), { stops: [[0, 1, 0, 1], [0, 1, 0, 1]], places: undefined, fade: [1, 0], fadePlaces: undefined });
  assert.equal(gradientFill({ fill: "#00ff00" }), null);
  assert.equal(gradientFill({ fillColors: ["#fff"] }), null);
  assert.equal(gradientFill({ fillColors: ["#fff", "not a colour"] }), null);
  assert.equal(gradientFill({ fill: "#fff", fade: [1] }), null);
});

test("Windows draws the fill top to bottom and the fade left to right, as Surface.swift does", () => {
  const mac = source("../../../../packages/shell/ios/Surface.swift");
  assert.match(mac, /fillGradient\.startPoint = CGPoint\(x: 0\.5, y: flipped \? 0 : 1\)\n\s+fillGradient\.endPoint = CGPoint\(x: 0\.5, y: flipped \? 1 : 0\)/);
  assert.match(mac, /fadeMask\.startPoint = CGPoint\(x: 0, y: 0\.5\)\n\s+fadeMask\.endPoint = CGPoint\(x: 1, y: 0\.5\)/);
  assert.match(mac, /plate\.mask = fadeMask/);
  const surface = source("../../../../packages/expo-windows/src/views/Surface.tsx");
  assert.match(surface, /const TOP_TO_BOTTOM = 180;\nconst LEFT_TO_RIGHT = 90;/);
  assert.match(surface, /angle=\{TOP_TO_BOTTOM\}/);
  assert.match(surface, /fadeAngle=\{LEFT_TO_RIGHT\}/);
});

test("the native gradient places its stops and masks itself with the fade's alpha", () => {
  const view = source("../../windows/Ardia/GradientView.h");
  assert.match(view, /m_masked = m_compositor\.CreateMaskBrush\(\);\n\s+m_masked\.Source\(m_gradient\);\n\s+m_masked\.Mask\(m_mask\);/);
  assert.match(view, /Materials::ColorFromUnit\(0, 0, 0, alpha\)/);
  assert.match(view, /GradientParts::StopAt\(m_stops, i, count\)/);
  assert.match(view, /GradientParts::StopAt\(m_fadeStops, i, m_fade\.size\(\)\)/);
  assert.match(source("../../windows/Ardia/MaterialsModule.h"), /masked\.Mask\(fade\);/);
  const project = source("../../windows/Ardia/Ardia.vcxproj");
  for (const header of ["GradientView.h", "MaterialViewParts.h"]) assert.ok(project.includes(`<ClInclude Include="${header}" />`), header);
});

test("the striped fallback keeps a thin bottom line and the fade's soft front", () => {
  const lineTop = 1 - 1.5 / 30;
  const glow = gradientFill({ fillColors: ["#2060ff10", "#2060ff30", "#2060ffff", "#2060ffff"], fillStops: [0, lineTop * 0.6, lineTop, 1], fade: [1, 0.55, 0.3, 0], fadeStops: [0, 0.7, 0.85, 1] });
  const rows = fallbackRows(glow);
  const line = rows.filter((row) => row.at >= lineTop - 1e-9);
  assert.equal(line.length, 1, "the line is one row of its own");
  assert.ok(Math.abs(line[0].size - (1 - lineTop)) < 1e-9, `the line row is ${line[0].size} tall`);
  assert.ok(Math.abs(line[0].color[3] - 1) < 1e-6, "the line is opaque");
  assert.ok(rows[0].color[3] < 0.1, "the top is faint");
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.size, 0) - 1) < 1e-9, "rows fill the height");
  const columns = fallbackColumns(glow);
  assert.ok(columns.length >= 4, `${columns.length} columns`);
  assert.ok(columns[0].opacity > 0.9 && columns.at(-1).opacity < 0.2, "opaque at the start, nearly gone at the front");
  for (let i = 1; i < columns.length; i++) assert.ok(columns[i].opacity <= columns[i - 1].opacity + 1e-9, "the fade never brightens");
  assert.ok(Math.abs(columns.reduce((sum, column) => sum + column.size, 0) - 1) < 1e-9, "columns fill the width");
  assert.deepEqual(fallbackColumns(gradientFill({ fillColors: ["#000", "#fff"] })), [{ at: 0, size: 1, opacity: 1 }]);
  assert.doesNotMatch(source("../../../../packages/expo-windows/src/views/Surface.tsx"), /<Bands /);
});

const files = (dir) =>
  readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${dir}${entry.name}/`) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [`${dir}${entry.name}`] : [],
  );
const DRAWS_THE_GRADIENT = "../../../../packages/expo-windows/src/views/Surface.tsx";
const using = (pattern) => [...files("../"), ...files("../../../../packages/expo-windows/src/")].filter((file) => file !== DRAWS_THE_GRADIENT && pattern.test(source(file))).sort();

test("a gradient-only Surface cuts no page window, and every gradient drawn sits inside a plate that does", () => {
  const surface = source("../../../../packages/expo-windows/src/views/Surface.tsx");
  assert.match(surface, /const own = gradient \? \{ ref, onLayout \} : \{ ref: cover\.ref, onLayout: cover\.onLayout \};/);
  assert.deepEqual(using(/\bfillColors=|\bfadeStops=/), ["../components/ui/GradientFill.tsx"], "only GradientFill gives a Surface a gradient");
  assert.deepEqual(using(/<GradientFill\b/), ["../components/toolbar/FieldLoadFill.tsx"], "only the field glow draws a GradientFill");
  assert.deepEqual(using(/<FieldLoadFill\b/), ["../components/littleArdia/SmallChrome.tsx", "../components/toolbar/Toolbar.tsx"], "the glow sits in the toolbar, sidebar and Little Ardia fields");
});

test("a gradient brush that fails reports it once, at once, and every mounted layer reading it draws the striped fallback", () => {
  assert.match(source("../../windows/Ardia/GradientView.h"), /void Fail\(std::wstring const &reason\) noexcept \{\n\s+Materials::MarkGradientFailed\(\);/);
  const failures = source("../../windows/Ardia/GradientFailures.h");
  assert.match(failures, /if \(GradientFailed\(\)\.exchange\(true\)\) return;/);
  assert.match(failures, /EmitEvent\(context, L"ArdiaMaterials", L"gradientFailed", /);
  assert.match(source("../../windows/Ardia/MaterialSupport.h"), /inline std::atomic<bool> &GradientFailed\(\) noexcept \{/);
  assert.match(source("../../windows/Ardia/MaterialsModule.h"), /m_context = context;\n\s+Materials::ReportGradientFailuresTo\(context\);/);
  assert.match(source("../../windows/Ardia/MaterialsModule.h"), /answer\.gradient = Materials::GradientAvailable\(\);/);
  assert.match(source("../../windows/Ardia/Ardia.cpp"), /Ardia::Materials::ReportGradientFailuresTo\(nullptr\);\n  host\.engine = nullptr;\n  SetFocus\(nullptr\);\n  if \(host\.queue\) host\.queue\.ShutdownQueue\(\);/);
  assert.ok(source("../../windows/Ardia/Ardia.vcxproj").includes('<ClInclude Include="GradientFailures.h" />'));
  const surface = source("../../../../packages/expo-windows/src/views/Surface.tsx");
  assert.match(surface, /const \[draws, setDraws\] = useState\(gradientDrawsNow\);\n\s+useEffect\(\(\) => \(draws \? followGradientFailure\(\(\) => setDraws\(false\)\) : undefined\), \[draws\]\);/);
  assert.match(surface, /if \(!useGradientDraws\(\)\) return <StripedGradient /);
  assert.doesNotMatch(surface, /setTimeout|watchGradientFailure/);
});
