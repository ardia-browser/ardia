import type { BrowserState } from "../browser/store";
import { isWindowClosing } from "./closingWindows";
import { engineProfile, incognitoOriginal } from "../browser/model";
import type { BrowserWindow, MainWindow } from "../browser/types";
import { WINDOW_CHROME } from "../../lib/windowChrome";

export const SMALL_BAR_HEIGHT = 38;
export const SMALL_LIGHTS_CENTER: [number, number] = [20, SMALL_BAR_HEIGHT / 2];
export const SMALL_WINDOW_BAR_HEIGHT = Math.max(SMALL_BAR_HEIGHT, WINDOW_CHROME.titleBarHeight);

export const isSmallWindow = (w: BrowserWindow | undefined): boolean => w?.kind === "small";

export const isRegularWindow = (w: BrowserWindow | undefined): w is MainWindow => w?.kind === "main";

export const isSmall = (s: Pick<BrowserState, "windows">, windowId?: string | null): boolean =>
  !!windowId && s.windows[windowId]?.kind === "small";

export const isOpenRegularWindow = (w: BrowserWindow | undefined): boolean => isRegularWindow(w) && !isWindowClosing(w.id);

export const isLastRegularWindow = (s: Pick<BrowserState, "windows">, id: string): boolean =>
  isRegularWindow(s.windows[id]) && !Object.values(s.windows).some((o) => o.id !== id && isOpenRegularWindow(o));

export function mainWindowFor(s: BrowserState, spaceId?: string): string | undefined {
  const order = [...new Set([...s.ui.focusOrder, ...s.windowOrder])].filter((id) => isOpenRegularWindow(s.windows[id]));
  return (spaceId ? order.find((id) => s.windows[id]!.spaceId === spaceId) : undefined) ?? order[0];
}

export function originalSpace(s: Pick<BrowserState, "spaces">, w: BrowserWindow | undefined): string | undefined {
  const id = w?.kind === "private" ? incognitoOriginal(w.spaceId) : w?.spaceId;
  return id && s.spaces[id] ? id : undefined;
}

export const linkSpaceOf = (s: Pick<BrowserState, "spaces">, w: BrowserWindow | undefined): string | undefined =>
  isSmallWindow(w) ? undefined : originalSpace(s, w);

export function privateWindowSpace(s: Pick<BrowserState, "spaces" | "spaceOrder" | "profiles">, w: BrowserWindow | undefined, engineName?: string) {
  const original = originalSpace(s, w);
  if (engineName === undefined || original && engineProfile(s, original) === engineName) return original;
  const named = s.spaceOrder.find((p) => engineProfile(s, p) === engineName);
  return named ?? originalSpace(s, w);
}

export function lastActiveSpace(s: Pick<BrowserState, "spaces" | "windows" | "windowOrder" | "ui" | "settings">): string {
  const last = s.ui.lastSpaceId;
  if (last && s.spaces[last]) return last;
  for (const id of [...s.ui.focusOrder, ...[...s.windowOrder].reverse()]) {
    const space = linkSpaceOf(s, s.windows[id]);
    if (space) return space;
  }
  return s.settings.defaultSpaceId;
}
