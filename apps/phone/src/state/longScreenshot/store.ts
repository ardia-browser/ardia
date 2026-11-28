import { create } from "zustand";
import { isWholeCrop, savedShotOf, shotOf, type Crop, type SavedShot, type Shot } from "../../lib/longScreenshot";
import { pages } from "../../platform/pages";
import { countUsage } from "../telemetry/telemetry";
import { showToast } from "../toasts/store";

export type LongScreenshotStage =
  | { kind: "idle" }
  | { kind: "capturing"; tabId: string }
  | { kind: "preview"; tabId: string; shot: Shot; saving: boolean }
  | { kind: "saved"; tabId: string; shot: Shot; saved: SavedShot; sharing: boolean };

export const CAPTURE_FAILED = "Couldn’t Take a Long Screenshot";
export const SAVE_FAILED = "Couldn’t Save the Screenshot";
export const SHARE_FAILED = "Couldn’t Share the Screenshot";

export const useLongScreenshot = create<{ stage: LongScreenshotStage }>()(() => ({ stage: { kind: "idle" } }));

const stage = () => useLongScreenshot.getState().stage;
const enter = (next: LongScreenshotStage) => useLongScreenshot.setState({ stage: next });

const COVERED_MS = 160;

let run = 0;

export function canTakeLongScreenshots(): boolean {
  try {
    return pages.canTakeLongScreenshot();
  } catch {
    return false;
  }
}

function failed(message: string) {
  countUsage("long_screenshot_failed");
  showToast(message, "warning");
}

function forget(shot: Shot) {
  void pages.discardLongScreenshot(shot.id).catch(() => undefined);
}

export async function takeLongScreenshot(tabId: string, isPrivate: boolean) {
  if (isPrivate || stage().kind !== "idle" || !canTakeLongScreenshots()) return;
  const mine = ++run;
  enter({ kind: "capturing", tabId });
  await new Promise((done) => setTimeout(done, COVERED_MS));
  if (mine !== run) return;
  const raw = await pages.takeLongScreenshot(tabId).catch(() => null);
  const shot = shotOf(raw);
  if (mine !== run) {
    if (shot) forget(shot);
    return;
  }
  if (!shot) {
    enter({ kind: "idle" });
    failed(CAPTURE_FAILED);
    return;
  }
  enter({ kind: "preview", tabId, shot, saving: false });
}

export function cancelLongScreenshot() {
  const now = stage();
  if (now.kind === "idle" || now.kind === "saved") return;
  if (now.kind === "preview" && now.saving) return;
  run += 1;
  if (now.kind === "preview") forget(now.shot);
  countUsage("long_screenshot_cancelled");
  enter({ kind: "idle" });
}

export async function saveLongScreenshot(crop: Crop) {
  const now = stage();
  if (now.kind !== "preview" || now.saving) return;
  const mine = ++run;
  const { shot, tabId } = now;
  enter({ ...now, saving: true });
  const top = isWholeCrop(shot, crop) ? 0 : crop.top;
  const bottom = isWholeCrop(shot, crop) ? shot.height : crop.bottom;
  const saved = savedShotOf(await pages.saveLongScreenshot(shot.id, top, bottom).catch(() => null));
  if (mine !== run) return;
  if (!saved) {
    enter({ kind: "preview", tabId, shot, saving: false });
    failed(SAVE_FAILED);
    return;
  }
  countUsage("long_screenshot_saved");
  enter({ kind: "saved", tabId, shot, saved, sharing: false });
}

export async function shareLongScreenshot() {
  const now = stage();
  if (now.kind !== "saved" || now.sharing) return;
  enter({ ...now, sharing: true });
  const shown = await pages.shareLongScreenshot(now.saved.uri).catch(() => false);
  const after = stage();
  if (after.kind === "saved" && after.saved.uri === now.saved.uri) enter({ ...after, sharing: false });
  if (shown) countUsage("long_screenshot_shared");
  else failed(SHARE_FAILED);
}

export function closeLongScreenshot() {
  const now = stage();
  if (now.kind !== "saved") return;
  run += 1;
  forget(now.shot);
  enter({ kind: "idle" });
}

export function longScreenshotBack(): boolean {
  const now = stage();
  if (now.kind === "idle") return false;
  if (now.kind === "saved") closeLongScreenshot();
  else cancelLongScreenshot();
  return true;
}
