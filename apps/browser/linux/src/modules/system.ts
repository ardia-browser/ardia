import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineModule } from "../bridge";
import { launchConfig } from "../launch";
import { note } from "../log";
import { isBackground } from "../paths";
import { DESKTOP_FILE, MIME_TYPES, autostartFile, defaultApplicationIn, ensureUserDesktopEntry, runTool, writeAutostart, writeDefaultApplications, xdg } from "../system/desktopEntry";

function nativePath(path: string): string {
  if (typeof path !== "string") return "";
  if (path.startsWith("file:")) {
    try {
      return fileURLToPath(path);
    } catch {
      return "";
    }
  }
  return path;
}

const XDG_SET_MS = 3000;

async function defaultBrowserState() {
  const browser = await xdg("xdg-settings", "get", "default-web-browser");
  const http = (await xdg("xdg-mime", "query", "default", "x-scheme-handler/http")) ?? defaultApplicationIn("x-scheme-handler/http");
  const https = (await xdg("xdg-mime", "query", "default", "x-scheme-handler/https")) ?? defaultApplicationIn("x-scheme-handler/https");
  return { desktopFile: DESKTOP_FILE, browser, http, https, isDefault: browser === DESKTOP_FILE || (http === DESKTOP_FILE && https === DESKTOP_FILE) };
}

function reportDefaultBrowserFailure(detail: string) {
  note("system", `couldn't make Ardia the default browser: ${detail}`);
  if (isBackground()) return;
  const options = {
    type: "warning" as const,
    message: "Ardia couldn't make itself your default browser",
    detail: `${detail}\n\nYou can choose Ardia as your web browser in your desktop's settings (Default Applications).`,
    buttons: ["OK"],
  };
  const window = BrowserWindow.getFocusedWindow();
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
}

async function setAsDefaultBrowser(): Promise<boolean> {
  if (isBackground()) {
    note("system", "background instance, not setting the default browser");
    return false;
  }
  await ensureUserDesktopEntry().catch((error) => note("system", `the desktop entry could not be written: ${String(error)}`));
  const tool = await runTool("xdg-settings", ["set", "default-web-browser", DESKTOP_FILE], XDG_SET_MS);
  if (!tool.ok) {
    note("system", `xdg-settings ${tool.timedOut ? "timed out" : `failed: ${tool.stderr || "no output"}`}; writing mimeapps.list`);
    try {
      writeDefaultApplications(DESKTOP_FILE, [...MIME_TYPES, "x-scheme-handler/about", "x-scheme-handler/unknown"]);
    } catch (error) {
      note("system", `mimeapps.list could not be written: ${String(error)}`);
    }
  }
  const state = await defaultBrowserState();
  if (!state.isDefault) reportDefaultBrowserFailure(`The desktop still opens links with ${state.browser || state.http || "another browser"}.`);
  return state.isDefault;
}

async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (isBackground()) return note("system", "background instance, not changing launch at login");
  if (launchConfig().isolated) return note("system", "custom data directory, not changing launch at login");
  if (enabled) await ensureUserDesktopEntry();
  writeAutostart(enabled);
}

async function fileIcon(path: string, size: number): Promise<string | null> {
  const target = nativePath(path);
  if (!target) return null;
  try {
    const icon = await app.getFileIcon(target, { size: size <= 16 ? "small" : size <= 32 ? "normal" : "large" });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

defineModule("ArdiaSystem", {
  constants: { backgroundInstance: isBackground() },
  sync: {
    fileExists: (path: string) => {
      const target = nativePath(path);
      return !!target && existsSync(target);
    },
    hapticTick: () => {},
  },
  async: {
    isDefaultBrowser: async () => (await defaultBrowserState()).isDefault,
    setAsDefaultBrowser,
    defaultBrowserState,
    launchAtLoginStatus: async () => (existsSync(autostartFile()) ? "enabled" : "notRegistered"),
    setLaunchAtLogin,
    openFile: async (path: string) => {
      const target = nativePath(path);
      if (!target || !existsSync(target)) return false;
      if (isBackground()) return true;
      return (await shell.openPath(target)) === "";
    },
    revealFile: async (path: string) => {
      const target = nativePath(path);
      if (!target || !existsSync(target)) return false;
      if (!isBackground()) shell.showItemInFolder(target);
      return true;
    },
    moveToTrash: async (path: string) => {
      const target = nativePath(path);
      if (!target || !existsSync(target)) return false;
      try {
        await shell.trashItem(target);
        return true;
      } catch {
        return false;
      }
    },
    fileIcon,
    runningAppIcon: async () => null,
    setThinScrollBars: async () => {},
  },
});
