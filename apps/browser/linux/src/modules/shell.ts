import { BrowserWindow, app, clipboard, nativeTheme, net, powerMonitor } from "electron";
import { defineModule, emit } from "../bridge";
import { testValue } from "../launch";
import { note } from "../log";
import { whenScreenLocks } from "../system/screenLock";

const BANG_LIST_URL = "https://services.helium.imput.net/bangs.json";

type AppearanceMode = "auto" | "light" | "dark";

let lastDark: boolean | null = null;

export const emitAppEvent = (payload: Record<string, unknown>) => emit("ArdiaShell", "onAppEvent", payload);

function noteAppearance(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  if (dark === lastDark) return;
  lastDark = dark;
  emitAppEvent({ type: "appearance", dark });
}

function setAppearance(mode: AppearanceMode): void {
  nativeTheme.themeSource = mode === "light" ? "light" : mode === "dark" ? "dark" : "system";
  noteAppearance();
}

async function fetchBangList(etag: string | null) {
  const url = testValue("bangsUrl") || BANG_LIST_URL;
  const response = await net.fetch(url, { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-store" });
  const body = response.status === 200 ? await response.text() : null;
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    contentType: response.headers.get("content-type"),
    body,
    bytes: body ? Buffer.byteLength(body) : 0,
  };
}

function watchActivation(): void {
  let resignTimer: ReturnType<typeof setTimeout> | undefined;
  app.on("browser-window-blur", () => {
    clearTimeout(resignTimer);
    resignTimer = setTimeout(() => {
      if (!BrowserWindow.getFocusedWindow()) emitAppEvent({ type: "resignActive" });
    }, 50);
  });
  app.on("browser-window-focus", () => clearTimeout(resignTimer));
  whenScreenLocks(() => {
    emitAppEvent({ type: "lockedOrAsleep" });
    emitAppEvent({ type: "screenLocked" });
  });
  powerMonitor.on("suspend", () => emitAppEvent({ type: "lockedOrAsleep" }));
}

app.whenReady().then(() => {
  lastDark = nativeTheme.shouldUseDarkColors;
  nativeTheme.on("updated", noteAppearance);
  watchActivation();
});

defineModule("ArdiaShell", {
  sync: {
    copyText: (text: string) => {
      clipboard.writeText(String(text));
      return true;
    },
    startDictation: () => {
      note("shell", "dictation isn't on Linux");
    },
  },
  async: {
    setAppearance: async (mode: AppearanceMode) => setAppearance(mode),
    isDarkAppearance: async () => nativeTheme.shouldUseDarkColors,
    readText: async () => clipboard.readText(),
    fetchBangList,
  },
});
