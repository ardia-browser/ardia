import type { BrowserWindow, Menu } from "electron";

export function popUpOver(menu: Menu, window: BrowserWindow | null | undefined, closed?: () => void): void {
  if (window && !window.isDestroyed()) window.focus();
  menu.popup({ ...(window && !window.isDestroyed() ? { window } : {}), ...(closed ? { callback: closed } : {}) });
}
