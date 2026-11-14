import { app, BrowserWindow } from "electron";
import { count } from "./counts";

const RETURN_AFTER_MS = 100;
const recentlyFocused: BrowserWindow[] = [];

const focusable = (window: BrowserWindow | null | undefined): window is BrowserWindow =>
  !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocusable();

function forget(window: BrowserWindow) {
  const at = recentlyFocused.indexOf(window);
  if (at >= 0) recentlyFocused.splice(at, 1);
}

export function returnFocus(preferred?: BrowserWindow | null): void {
  setTimeout(() => {
    if (BrowserWindow.getFocusedWindow()) return;
    const target = [preferred, ...[...recentlyFocused].reverse()].find(focusable);
    if (!target) return;
    count("focus_returned");
    target.focus();
  }, RETURN_AFTER_MS);
}

export function installFocusReturn(): void {
  app.on("browser-window-focus", (_event, window) => {
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
