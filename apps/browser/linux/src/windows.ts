import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { addReceiver } from "./bridge";
import { trustHost } from "./ipcSenders";
import { guardAppWindow, guardHost, mayOpenFromHost } from "./navigationGuards";

export const preloadPath = () => join(__dirname, "preload.js");
export const appWindowPreloadPath = () => join(__dirname, "window-preload.js");

type CreatedListener = (id: string, window: BrowserWindow) => void;

const pending = new Map<string, BrowserWindowConstructorOptions>();
const appWindows = new Map<string, BrowserWindow>();
const auxiliaryNames = new Set<string>();
const auxiliaryWindows = new Map<string, BrowserWindow>();
const createdListeners = new Set<CreatedListener>();
let hostWindow: BrowserWindow | null = null;

export function shapeNextWindow(id: string, options: BrowserWindowConstructorOptions): void {
  pending.set(id, options);
}

export function shapeNextAuxiliaryWindow(name: string, options: BrowserWindowConstructorOptions): void {
  auxiliaryNames.add(name);
  pending.set(name, options);
}

export const auxiliaryWindow = (name: string): BrowserWindow | undefined => auxiliaryWindows.get(name);

export const appWindow = (id: string): BrowserWindow | undefined => appWindows.get(id);
export const appWindowIds = (): string[] => [...appWindows.keys()];
export const host = (): BrowserWindow | null => hostWindow;

export function appWindowIdOf(window: BrowserWindow | null | undefined): string | null {
  if (!window) return null;
  for (const [id, open] of appWindows) if (open === window) return id;
  return null;
}

export function onAppWindowCreated(listener: CreatedListener): () => void {
  createdListeners.add(listener);
  return () => void createdListeners.delete(listener);
}

const sharedWebPreferences = { contextIsolation: true, sandbox: false, webviewTag: true, backgroundThrottling: false, spellcheck: true } as const;

export function createHost(load: (window: BrowserWindow) => Promise<void>): BrowserWindow {
  const made = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { preload: preloadPath(), ...sharedWebPreferences },
  });
  hostWindow = made;
  addReceiver(made.webContents);
  trustHost(made.webContents);
  guardHost(made.webContents);
  made.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const shaped = pending.get(frameName);
    pending.delete(frameName);
    if (!mayOpenFromHost(url, frameName, !!shaped) || !shaped) return { action: "deny" };
    return {
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        frame: false,
        show: false,
        backgroundColor: "#00000000",
        transparent: true,
        resizable: true,
        ...shaped,
        webPreferences: { ...sharedWebPreferences, preload: appWindowPreloadPath(), ...shaped.webPreferences },
      },
    };
  });
  made.webContents.on("did-create-window", (child, { frameName }) => {
    guardAppWindow(child.webContents, frameName);
    if (auxiliaryNames.has(frameName)) {
      auxiliaryWindows.set(frameName, child);
      child.once("closed", () => auxiliaryWindows.delete(frameName));
      return;
    }
    appWindows.set(frameName, child);
    child.once("closed", () => {
      if (appWindows.get(frameName) === child) appWindows.delete(frameName);
    });
    for (const listener of createdListeners) listener(frameName, child);
  });
  void load(made);
  return made;
}
