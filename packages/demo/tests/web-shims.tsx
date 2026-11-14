import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { subscribeFrames } from "../src/shims/web/gl/clock";
import { paletteColors } from "../src/shims/web/gl/colors";
import { currentPointer } from "../src/shims/web/motion/pointer";
import { MacView } from "../src/shims/web/motion/macView";

document.body.style.cssText = "margin:40px;background:#f6f5f2;color:#202020;font:18px system-ui";
document.getElementById("root")!.innerHTML = `
  <h1>Ardia web shim regression checks</h1>
  <p>Issue #1554. Real clock, palette, pointer and rendered MacView modules.</p>
  <p>Click Run checks, then leave the pointer still.</p>
  <div id="hover" style="width:420px;height:120px;margin:28px 0">
    <button id="run" style="width:100%;height:100%;font:inherit">Run checks</button>
  </div>
  <p id="animation">Healthy animation frames: 0. Reported ticker errors: 0.</p>
  <div id="checks"></div>
  <pre id="results" style="font:16px ui-monospace;white-space:pre-wrap"></pre>
`;

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
