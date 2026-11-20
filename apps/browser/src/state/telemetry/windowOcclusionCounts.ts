import { chromeWindows, onWindowEvent } from "../../platform/windows";
import { consentToken, counted, type ConsentToken } from "./client";

const SETTLE_MS = 1500;
const NONE = { focused_window_checks: 0, focused_window_pages_occluded: 0 };
let counts = { ...NONE };
let settling: ReturnType<typeof setTimeout> | null = null;

async function checkFocusedWindowOcclusion(token: ConsentToken | null) {
  const key = (await chromeWindows().catch(() => [])).find((w) => w.key && w.visible);
  if (!key) return;
  const occluded = key.chromeOccluded === true && !!key.occlusionVisible;
  counted(token, () => {
    counts.focused_window_checks++;
    if (occluded) counts.focused_window_pages_occluded++;
  });
}

onWindowEvent((e) => {
  if (e.type !== "focus") return;
  if (settling) clearTimeout(settling);
  settling = null;
  const token = consentToken();
  settling = setTimeout(() => {
    settling = null;
    void checkFocusedWindowOcclusion(token);
  }, SETTLE_MS);
});

export function takeWindowOcclusionCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
