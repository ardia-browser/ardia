import type { BrowserWindow } from "../browser/types";

export function withFullScreen(w: BrowserWindow, on: boolean, display?: string): BrowserWindow | null {
  if (!!w.fullScreen === on) return on && display && w.display !== display ? { ...w, display } : null;
  const { fullScreen: _, display: __, ...rest } = w;
  return on ? { ...rest, fullScreen: Date.now(), ...(display ? { display } : {}) } : rest;
}
