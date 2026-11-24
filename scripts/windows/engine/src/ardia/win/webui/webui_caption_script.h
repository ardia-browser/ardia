#ifndef ARDIA_WIN_WEBUI_WEBUI_CAPTION_SCRIPT_H_
#define ARDIA_WIN_WEBUI_WEBUI_CAPTION_SCRIPT_H_

namespace ardia_win {

inline constexpr char kWindowsCaptionScript[] = R"ardia_caption((() => {
  "use strict";
  const host = window.__ardiaHost;
  if (!host || window.__ardiaWindowsCaption) return;
  Object.defineProperty(window, "__ardiaWindowsCaption", { value: true });
  const selector = [
    '.ardia-window-controls [role="button"][aria-label="Maximize"]',
    '.ardia-window-controls [role="button"][aria-label="Restore Down"]',
    '[data-ardia-window-control="zoom"]',
  ].join(", ");
  let last = "";
  const report = () => {
    const button = document.querySelector(selector);
    const box = button ? button.getBoundingClientRect() : null;
    const shown = box && box.width > 0 && box.height > 0 && getComputedStyle(button).visibility !== "hidden";
    const rect = shown ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    const json = JSON.stringify(rect);
    if (json === last) return;
    last = json;
    host.invoke("ArdiaShell.setMaximizeButton", { rect }).catch(() => { last = ""; });
  };
  setInterval(report, 250);
  addEventListener("resize", report);
})();
)ardia_caption";

}

#endif
