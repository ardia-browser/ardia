import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { subscribeFrames } from "../src/shims/web/gl/clock";
import { paletteColors } from "../src/shims/web/gl/colors";
import { currentPointer } from "../src/shims/web/motion/pointer";
import { MacView } from "../src/shims/web/motion/macView";
import { FadeLabel } from "../src/shims/web/FadeLabel";
import { holdThemedWindowsKeyLook, ThemeSwatch, WindowBackdrop } from "../src/shims/shaders";
import { Breathe } from "../src/shims/shell";
import { VisualEffect } from "../src/shims/web/chrome";
import { useBrowser } from "../../../apps/browser/src/state/browser/store";
import { ThemeContext, themeFor } from "../../../apps/browser/src/components/ui/theme";
import { Panel } from "../../../apps/browser/src/components/ui/Panel";
import { Button } from "../../../apps/browser/src/components/ui/Button";
import { SelectableCard } from "../../../apps/browser/src/components/settings/SelectableCard";
import { Slider } from "../../../apps/browser/src/components/settings/ThemeControls";
import { Image, View, type ImageSourcePropType } from "react-native";
import stripesSource from "../../../apps/browser/assets/dev-stripes-dark-ink.png";
import broomSource from "../../../apps/browser/assets/tidy-broom.png";
import markSource from "../../../apps/browser/assets/ntp-mark-sun.png";

document.body.style.cssText = "margin:40px;background:#f6f5f2;color:#202020;font:18px system-ui";
document.getElementById("root")!.innerHTML = `
  <h1>Ardia web shim regression checks</h1>
  <p>Issue #1554. Real clock, palette, pointer and rendered MacView modules.</p>
  <p>Click Run checks, then leave the pointer still.</p>
  <div id="hover" style="width:420px;height:120px;margin:28px 0">
    <button id="run" style="width:100%;height:100%;font:inherit">Run checks</button>
  </div>
  <p id="animation">Healthy animation frames: 0. Reported ticker errors: 0.</p>
  <div id="labels" style="width:200px"></div>
  <div id="swatches" style="position:relative;width:240px;height:120px"></div>
  <div id="images" style="position:relative"></div>
  <div id="ring" style="display:inline-block;padding:8px;background:#1e1e1e"></div>
  <div id="ring-under" style="display:inline-block;padding:8px;background:#1e1e1e"></div>
  <div class="ardia-window" style="position:relative;margin-left:120px;width:360px"><div id="drag"></div></div>
  <div style="position:relative;width:2400px;height:1800px"><div class="ardia-window" style="position:absolute;left:1700px;top:1500px;width:360px"><div id="drag-far"></div></div></div>
  <div id="checks"></div>
  <pre id="results" style="font:16px ui-monospace;white-space:pre-wrap"></pre>
`;

const sliderValues: Record<string, string[]> = { drag: [], "drag-far": [] };
(window as unknown as { sliderValues: Record<string, string[]> }).sliderValues = sliderValues;
function DragHarness({ log }: { log: string[] }) {
  const [value, setValue] = useState(0.2);
  return createElement(Slider, { label: "Intensity", value, onChange: (next: number, settle: boolean) => { log.push(`${next.toFixed(3)}${settle ? "!" : ""}`); setValue(next); } });
}
for (const id of Object.keys(sliderValues)) {
  createRoot(document.getElementById(id)!).render(createElement(ThemeContext.Provider, { value: themeFor("plum:light") }, createElement(DragHarness, { log: sliderValues[id]! })));
}

document.getElementById("run")!.addEventListener("click", async (event) => {
  const checks: Record<string, boolean> = {};
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement) || !(event instanceof MouseEvent)) throw new Error("Run checks needs a mouse click");
  const pointer = currentPointer();
  checks.pointerBeforeSubscriber = !!pointer && Math.floor(pointer.clientX) === event.clientX && Math.floor(pointer.clientY) === event.clientY;
  button.disabled = true;
  try {
    checks.inheritedPalette = paletteColors(["toString"]) === null && paletteColors(["constructor"]) === null;
  } catch {
    checks.inheritedPalette = false;
  }
  checks.validPalette = JSON.stringify(paletteColors(["#ff0000"])) === "[[1,0,0,1]]" && paletteColors(["red"])?.length === 5;

  const labels = createRoot(document.getElementById("labels")!);
  flushSync(() => labels.render([
    createElement(FadeLabel, { key: "struck", nativeID: "struck", text: "Sleeping tab", strikethrough: true }),
    createElement(FadeLabel, { key: "plain", nativeID: "plain", text: "Awake tab" }),
  ]));
  const decoration = (id: string) => getComputedStyle(document.querySelector(`#${id} span`)!).textDecorationLine;
  checks.fadeLabelStrikethrough = decoration("struck") === "line-through" && decoration("plain") === "none";

  const warnings: unknown[][] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  console.error = (...args: unknown[]) => void warnings.push(args);
  holdThemedWindowsKeyLook(true);
  holdThemedWindowsKeyLook(false);
  useBrowser.setState((s) => ({ ui: { ...s.ui, appDark: true } }));
  const swatches = createRoot(document.getElementById("swatches")!);
  const box = { width: 60, height: 40 };
  flushSync(() => swatches.render([
    createElement("div", { key: "swatch", id: "swatch" }, createElement(ThemeSwatch, { colors: [1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0.5], style: box })),
    createElement("div", { key: "grain", id: "grain" }, createElement(ThemeSwatch, { colors: [], grain: 0.5, texture: "sand", style: box })),
    createElement("div", { key: "pad", id: "pad" }, createElement(ThemeSwatch, { colors: [], padLightness: 0.5, style: box })),
    createElement("div", { key: "backdrop", id: "backdrop" }, createElement(WindowBackdrop, { colors: ["#000000", "#000000"], vibrancy: true, themeColors: [1, 0, 0, 1, 0, 0, 1, 1], themeOpacity: 0.7, themeBaseAlpha: 0.4, themeGrain: 0.2, themeTexture: "denim", themeAppearance: "dark", style: box })),
    createElement("div", { key: "effect", id: "effect" }, createElement(VisualEffect, { material: "sidebar", style: box })),
    createElement(ThemeContext.Provider, { key: "light", value: themeFor("plum:light") },
      createElement("div", { id: "toast" }, createElement(Panel, { fill: themeFor("plum:light").toastFill, radius: 12, material: "hudWindow", style: box })),
      createElement("div", { id: "close" }, createElement(Button, { variant: "close", look: "hud", onPress: () => {} })),
    ),
    createElement(ThemeContext.Provider, { key: "dark", value: themeFor("plum:dark") },
      createElement("div", { id: "toast-dark" }, createElement(Panel, { fill: themeFor("plum:dark").toastFill, radius: 12, material: "hudWindow", style: box })),
    ),
    createElement("div", { key: "breathe", id: "breathe" }, createElement(Breathe, { running: true, cycleMs: 1000, opacityRange: [0.4, 1], scaleRange: [1, 1.1], style: box })),
  ]));
  const swatch = document.querySelector<HTMLElement>("#swatch > div");
  checks.themeSwatchGradient = !!swatch && swatch.querySelectorAll("linearGradient").length === 2 && swatch.querySelectorAll("stop").length > 2 && swatch.getBoundingClientRect().width === 60;
  checks.themeSwatchGrain = /url\("?data:image\/png/.test(document.querySelector<HTMLElement>("#grain > div > div")?.style.backgroundImage ?? "");
  checks.colorPad = /conic-gradient/.test(document.querySelector<HTMLElement>("#pad > div > div")?.style.backgroundImage ?? "");
  const backdrop = document.querySelector<HTMLElement>("#backdrop > div");
  checks.themedBackdrop = !!backdrop && backdrop.querySelectorAll("linearGradient").length === 1 && /linear-gradient/.test(backdrop.querySelector<HTMLElement>(":scope > div")?.style.backgroundImage ?? "") && !backdrop.querySelector("canvas");
  checks.darkVisualEffect = getComputedStyle(document.querySelector("#effect > div")!).backgroundColor === "rgba(46, 46, 48, 0.5)";
  const fillsIn = (id: string) => [...document.querySelectorAll(`#${id} *`)].map((node) => getComputedStyle(node).backgroundColor);
  const LIGHT_HUD = "rgba(246, 246, 246, 0.6)";
  const DARK_HUD = "rgba(30, 30, 30, 0.6)";
  checks.lightToastOnLightHud = fillsIn("toast").includes(LIGHT_HUD) && !fillsIn("toast").includes(DARK_HUD);
  checks.darkToastOnDarkHud = fillsIn("toast-dark").includes(DARK_HUD);
  checks.hudCloseOnDarkHud = fillsIn("close").includes(DARK_HUD) && !fillsIn("close").includes(LIGHT_HUD);
  checks.breathe = /ardia-breathe-/.test(getComputedStyle(document.querySelector("#breathe > div > div")!).animationName);
  console.warn = warn;
  console.error = error;
  checks.holdKeyLookQuiet = !warnings.some((args) => args.some((arg) => /ArdiaThemeSwatch|ArdiaWindowBackdrop|ArdiaBreathe|native/i.test(String(arg))));
  flushSync(() => swatches.render(null));
  useBrowser.setState((s) => ({ ui: { ...s.ui, appDark: false } }));

  const images = createRoot(document.getElementById("images")!);
  const source = (value: unknown) => value as ImageSourcePropType;
  flushSync(() => images.render([
    createElement("div", { key: "stripes", id: "stripes" }, createElement(View, { style: { width: 200, height: 34 } },
      createElement(Image, { source: source(stripesSource), resizeMode: "repeat", style: { flex: 1, width: undefined, height: undefined } }))),
    createElement("div", { key: "broom", id: "broom" }, createElement(Image, { source: source(broomSource), style: { width: 11, height: 11, tintColor: "#202020" } })),
    createElement("div", { key: "mark", id: "mark", style: { display: "flex", alignItems: "flex-start" } }, createElement(Image, { source: source(markSource) })),
  ]));
  const loaded = async (id: string) => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const img = document.querySelector<HTMLImageElement>(`#${id} img`);
      if (img?.complete && img.naturalWidth) return img;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
  const [broomImg, markImg] = await Promise.all([loaded("broom"), loaded("mark")]);
  const tile = document.querySelector<HTMLElement>("#stripes > div > div");
  checks.retinaStripeTile = !!tile && tile.style.backgroundSize === "28px 28px" && tile.style.backgroundImage.includes("dev-stripes-dark-ink@2x.png") && tile.getBoundingClientRect().height === 34;
  checks.retinaIconSharp = broomImg?.naturalWidth === 33 && broomImg.src.includes("tidy-broom@3x.png") && document.querySelector("#broom > div")!.getBoundingClientRect().width === 11;
  checks.retinaMarkLogical = markImg?.naturalWidth === 200 && document.querySelector("#mark > div")!.getBoundingClientRect().width === 100;
  flushSync(() => images.render(null));
  const ring = createRoot(document.getElementById("ring")!);
  flushSync(() => ring.render(createElement(ThemeContext.Provider, { value: themeFor("plum:dark") },
    createElement(SelectableCard, { selected: true, fill: false, style: { width: 120, height: 104, flexDirection: "row" }, children: createElement(View, { style: { flex: 1, backgroundColor: "#2A2A2C" } }) }))));
  const ringUnder = createRoot(document.getElementById("ring-under")!);
  flushSync(() => ringUnder.render(createElement(ThemeContext.Provider, { value: themeFor("plum:dark") },
    createElement(View, { style: { width: 120, height: 104 } },
      createElement(SelectableCard, { selected: true, fill: false, style: { width: 120, height: 104, flexDirection: "row" }, children: createElement(View, { style: { flex: 1, backgroundColor: "#2A2A2C" } }) }),
      createElement(View, { style: { position: "absolute", left: 0, top: 0, width: 30, height: 30, zIndex: 1, backgroundColor: "#FF0000" } })))));

  let enters = 0;
  const mount = document.getElementById("hover")!;
  mount.replaceChildren();
  const root = createRoot(mount);
  flushSync(() => root.render(createElement(MacView, {
    pointerEvents: "box-none",
    onMouseEnter: () => {
      enters++;
      document.getElementById("hover-status")!.textContent = `Mounted under the still pointer. Enter events: ${enters}`;
    },
    style: { width: 420, height: 120, padding: 20, backgroundColor: "#dcebdd" },
  }, createElement("span", { id: "hover-status" }, "Mounted under the still pointer. Enter events: 0"))));

  let frames = 0;
  let errors = 0;
  const failure = new Error("intentional regression-test ticker failure");
  const onError = (error: ErrorEvent) => {
    if (error.error !== failure) return;
    errors++;
    error.preventDefault();
  };
  window.addEventListener("error", onError);
  const stopThrowing = subscribeFrames(() => { throw failure; });
  const stopHealthy = subscribeFrames(() => {
    frames++;
    document.getElementById("animation")!.textContent = `Healthy animation frames: ${frames}. Reported ticker errors: ${errors}.`;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  stopHealthy();
  stopThrowing();
  window.removeEventListener("error", onError);
  checks.clockSurvivesThrow = frames >= 3 && errors >= 3;
  checks.enterOnMount = enters === 1;
  const passed = Object.values(checks).filter(Boolean).length;
  document.getElementById("checks")!.innerHTML = Object.entries(checks).map(([name, ok]) => `<p style="color:${ok ? "#176124" : "#a51b1b"}">${ok ? "PASS" : "FAIL"} ${name}</p>`).join("");
  document.getElementById("results")!.textContent = JSON.stringify({ passed, total: Object.keys(checks).length, frames, errors, enters, checks }, null, 2);
});
