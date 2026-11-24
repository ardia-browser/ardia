import type { BrowserState } from "../browser/store";
import type { Frame } from "../browser/types";
import { isSmallWindow } from "./small";
import { settingsWith } from "../settings/settings";

const sameFrame = (a: Frame | null | undefined, b: Frame | null | undefined) => a === b || (!!a && !!b && a.every((v, i) => v === b[i]));

export function withWindowFrame(s: BrowserState, id: string, frame: Frame, restored?: Frame, fitted?: boolean): Partial<BrowserState> {
  const w = s.windows[id];
  if (!w || (sameFrame(w.frame, frame) && sameFrame(w.restoredFrame, restored))) return {};
  const { restoredFrame: _, ...rest } = w;
  const windows = { ...s.windows, [id]: { ...rest, frame, ...(restored ? { restoredFrame: restored } : {}) } };
  const resized = !w.frame || w.frame[2] !== frame[2] || w.frame[3] !== frame[3];
  if (fitted || !resized || !isSmallWindow(w)) return { windows };
  const size: [number, number] = [Math.round(frame[2]), Math.round(frame[3])];
  const [width, height] = s.settings.littleArdiaSize;
  return size[0] === width && size[1] === height ? { windows } : { windows, settings: settingsWith(s.settings, { littleArdiaSize: size }) };
}

export function withWindowMaximized(s: BrowserState, id: string, on: boolean): Partial<BrowserState> {
  const w = s.windows[id];
  if (!w || isSmallWindow(w) || !!w.maximized === on) return {};
  const { maximized: _, ...rest } = w;
  return { windows: { ...s.windows, [id]: on ? { ...rest, maximized: true } : rest } };
}
