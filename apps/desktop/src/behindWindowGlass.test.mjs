import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { behindWindowGlassSwitch, glassTreatment, wantsBehindWindowGlass, WINDOW_TREATMENT } from "./behindWindowGlass.ts";

test("glass behind the window follows the backdrop's vibrancy and theme as they change, and lets go on the way out", () => {
  const log = [];
  const toggle = behindWindowGlassSwitch({ watch: (element) => (log.push(["watch", element.id]), () => log.push(["stop", element.id])) });
  const layer = { id: "a" };
  toggle(layer, wantsBehindWindowGlass(false, true));
  assert.deepEqual(log, [], "plain backdrops draw in CSS");
  toggle(layer, wantsBehindWindowGlass(true, true));
  toggle(layer, wantsBehindWindowGlass(true, true));
  assert.deepEqual(log, [["watch", "a"]], "turning vibrancy on asks for glass once");
  toggle(layer, wantsBehindWindowGlass(false, true));
  assert.deepEqual(log.at(-1), ["stop", "a"], "turning vibrancy off takes the glass away");
  toggle(layer, wantsBehindWindowGlass(true, true));
  const replaced = { id: "b" };
  toggle(replaced, true);
  assert.deepEqual(log.slice(-3), [["watch", "a"], ["stop", "a"], ["watch", "b"]], "a new layer element moves the glass");
  toggle(null, false);
  assert.deepEqual(log.at(-1), ["stop", "b"], "unmounting lets go");
  assert.equal(wantsBehindWindowGlass(true, false), false, "a host without backdrop glass keeps CSS vibrancy");
});

test("WindowBackdrop decides on glass every render instead of freezing its first answer", () => {
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(source, /const behindGlass = wantsBehindWindowGlass\(vibrancy, glassAvailable\);/);
  assert.match(source, /useLayoutEffect\(\(\) => switchGlass\(layer\.current, behindGlass\)\);/);
  assert.doesNotMatch(source, /useState\(\(\) => !!vibrancy/);
});

test("over native glass the backdrop draws the Mac app's WindowTreatmentView: a smoky base and the tint's vertical lightness gradient", () => {
  const dark = glassTreatment(true, "#ff8000", 0.36, 0.25);
  assert.equal(dark.base, "rgba(0, 0, 0, 0.4)");
  assert.equal(dark.gradientOpacity, 0.5);
  assert.equal(dark.gradient, "linear-gradient(to bottom in display-p3, color(display-p3 1 0.50196 0 / 0.36), color(display-p3 1 0.75098 0.5 / 0.36))");
  const light = glassTreatment(false, "#ff8000", 0.36, 0.25);
  assert.equal(light.base, "rgba(255, 255, 255, 0.8)");
  assert.equal(light.gradientOpacity, 0.75);
  assert.equal(glassTreatment(true, undefined).gradient, glassTreatment(true, WINDOW_TREATMENT.tintColor, 0.36, 0.25).gradient, "no profile tint keeps the Mac's neutral grey tint");
  assert.match(glassTreatment(true, "rgba(10, 20, 30, 0.5)", 2).gradient, / \/ 1\)/, "the tint's alpha is the treatment's, clamped, as withAlphaComponent sets it");
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(behindGlass\) \{\n\s+const treatment = themed \? null : glassTreatment\(dark, tintColor, tintAlpha, tintLightness\);/);
  assert.match(source, /\{treatment \? <div data-ardia-glass-base="" style=\{\{ \.\.\.UNDERLAY_FILL, background: treatment\.base \}\} \/> : null\}\n\s+\{treatment \? <div data-ardia-glass-tint="" style=\{\{ \.\.\.UNDERLAY_FILL, background: treatment\.gradient, opacity: treatment\.gradientOpacity \}\} \/> : null\}/);
});

test("a window draws one backdrop: the shared base gives way while the profile pages draw theirs", () => {
  const app = readFileSync(new URL("../../browser/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /const \{ paging \} = usePagerPages\(windowId\);/);
  assert.match(app, /\{paging \? null : <WindowBackdrop vibrancy /);
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  assert.match(tint, /if \(!paging\) return null;/);
});

test("a themed profile keeps native glass behind the window and lays its theme over it, as the Mac app does", () => {
  assert.equal(wantsBehindWindowGlass(true, true), true);
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (behindGlass) {");
  const glassBranch = source.slice(start, source.indexOf("\n  return (", start));
  assert.match(glassBranch, /themed \? <ThemedVibrancy /);
  assert.match(glassBranch, /const treatment = themed \? null : glassTreatment\(dark, tintColor, tintAlpha, tintLightness\);/);
});

test("each profile page's backdrop takes that page's own appearance, so a light stock profile swiped in from a dark custom one is light all the way", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
  const { PageThemeContext, ThemeContext } = await import("../../browser/src/components/ui/theme.ts");
  const { useSurfaceDark } = await import("./shims/web/chrome.tsx");
  const Probe = () => (useSurfaceDark() ? "dark" : "light");
  const darkCustom = { dark: true };
  const lightStock = { dark: false };
  const before = useBrowser.getState().ui;
  useBrowser.setState((s) => ({ ui: { ...s.ui, appDark: false } }));
  try {
    const page = (selected, own) => renderToStaticMarkup(createElement(ThemeContext.Provider, { value: selected }, createElement(PageThemeContext.Provider, { value: own }, createElement(Probe))));
    assert.equal(page(darkCustom, lightStock), "light", "the incoming light stock page reads light while the dark custom profile is selected");
    assert.equal(page(lightStock, darkCustom), "dark", "the outgoing dark custom page stays dark after the light one is selected");
    assert.equal(renderToStaticMarkup(createElement(ThemeContext.Provider, { value: darkCustom }, createElement(Probe))), "dark", "without its own page theme a backdrop would follow the selected profile");
  } finally {
    useBrowser.setState({ ui: before });
  }
  const shaders = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(shaders, /const surfaceDark = useSurfaceDark\(\);/);
  assert.match(shaders, /: surfaceDark;/);
  const tint = readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8");
  assert.match(tint, /<PageThemeContext\.Provider value=\{theme\}>\n\s+<WindowBackdrop vibrancy /);
});
