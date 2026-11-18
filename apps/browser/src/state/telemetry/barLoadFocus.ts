import { webviews } from "../../platform/webviews";
import { isSharing } from "./choice";

const SETTLE_MS = 2000;
const NONE = { bar_loads: 0, bar_loads_page_focused: 0 };
let counts = { ...NONE };

export function noteBarLoad(tabId: string) {
  if (!tabId || !isSharing()) return;
  setTimeout(() => {
    if (!isSharing()) return;
    void webviews.get(tabId)?.evaluate("document.hasFocus()").then(
      (focused) => {
        counts.bar_loads++;
        if (focused === true) counts.bar_loads_page_focused++;
      },
      () => {},
    );
  }, SETTLE_MS);
}

export function takeBarLoadFocusCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
