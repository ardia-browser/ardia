import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the sidebar's text scope and the tinted ink provide their theme without a component of their own", () => {
  assert.match(read("./TintInk.tsx"), /return themeOverride\(tintTheme\(useTheme\(\)\), children\);/);
  assert.match(read("../sidebar/SidebarTextScope.tsx"), /return themeOverride\(strong \? contrastTheme\(theme\) : theme, <TextScopeContext\.Provider value="sidebar">/);
  assert.match(read("./ThemeOverride.tsx"), /export function ThemeOverride\(\{ theme, children \}[^)]*\) \{\n  return themeOverride\(theme, children\);/);
});

test("the window's overlays mount no wrapper on macOS; Linux wraps them in its overlay region through the same seam", () => {
  assert.match(read("../window/WindowOverlays.tsx"), /export const windowOverlays = \(children: ReactNode\) => <>\{children\}<\/>;/);
  assert.match(read("../../App.tsx"), /\{windowOverlays\(<ReportSheetHost \/>\)\}/);
  assert.match(read("../../../../linux/src/WindowOverlays.tsx"), /export const windowOverlays = \(children: ReactNode\) => <PageOverlayRegion testID="ardia-window-overlays">\{browserWindowOverlays\(children\)\}<\/PageOverlayRegion>;/);
});
