import { app, BrowserWindow } from "electron";
import { count } from "./counts";
import { desktopSession } from "./paths";
import { nothingElseFocused, queryXFocus } from "./system/xFocus";

const RETURN_AFTER_MS = 100;
const recentlyFocused: BrowserWindow[] = [];
let pending: { timer: ReturnType<typeof setTimeout>; preferred: BrowserWindow | null } | null = null;
let generation = 0;

const focusable = (window: BrowserWindow | null | undefined): window is BrowserWindow =>
  !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocusable();

function forget(window: BrowserWindow) {
  const at = recentlyFocused.indexOf(window);
  if (at >= 0) recentlyFocused.splice(at, 1);
}

function onX11(): boolean {
  const session = desktopSession();
  const chosen = app.commandLine?.getSwitchValue("ozone-platform") || session.ozonePlatformHint || "";
  if (chosen === "x11") return true;
  if (chosen === "wayland") return false;
  return !session.waylandDisplay && session.sessionType !== "wayland";
}

function ourXWindows(): Set<number> {
  const ours = new Set<number>();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const handle = window.getNativeWindowHandle();
    if (handle.length >= 4) ours.add(handle.readUInt32LE(0));
  }
  return ours;
}

async function focusIsFree(): Promise<boolean> {
  if (!onX11()) return true;
  try {
    return nothingElseFocused(await queryXFocus(), ourXWindows());
  } catch {
    count("focus_return_unverified");
    return false;
  }
}

function cancelPendingReturn() {
  if (pending) clearTimeout(pending.timer);
  pending = null;
  generation++;
}

export function returnFocus(wanted?: BrowserWindow | null): void {
  const preferred = wanted ?? pending?.preferred ?? null;
  cancelPendingReturn();
  const mine = generation;
  pending = {
    preferred,
    timer: setTimeout(async () => {
      pending = null;
      if (BrowserWindow.getFocusedWindow()) return;
      const target = [preferred, ...[...recentlyFocused].reverse()].find(focusable);
      if (!target) return;
      const free = await focusIsFree();
      if (mine !== generation || BrowserWindow.getFocusedWindow() || !focusable(target)) return;
      if (!free) return void count("focus_return_skipped");
      count("focus_returned");
      target.focus();
    }, RETURN_AFTER_MS),
  };
}

export function installFocusReturn(): void {
  app.on("browser-window-focus", (_event, window) => {
    cancelPendingReturn();
    forget(window);
    recentlyFocused.push(window);
  });
  app.on("browser-window-created", (_event, window) => {
    let closingFocused = false;
    window.on("close", () => (closingFocused = window.isFocused()));
    window.once("closed", () => {
      forget(window);
      if (closingFocused) returnFocus();
    });
  });
}
