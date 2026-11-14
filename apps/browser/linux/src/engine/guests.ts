import { app, BrowserWindow, type WebContents } from "electron";
import { defineModule, emit } from "../bridge";
import { appWindow, host } from "../windows";
import { emitPage } from "./pages";
import { profileOfSession } from "./sessions";
import { renderErrorPage, showsErrorPage } from "./errorPages";

export const PAGES_MODULE = "ArdiaLinuxPages";

export type ThemeSource = "meta" | "header" | "background" | null;

export type Guest = {
  contents: WebContents;
  profile: string;
  tabId: string;
  windowId: string;
  attached: boolean;
  waiting: [string, unknown][];
  url: string;
  title: string;
  isLoading: boolean;
  metaTheme: string | null;
  scriptTheme: { color: string | null; source: ThemeSource } | null;
  committedUrl: string;
  committedAt: number;
  httpStatus: number;
  progress: number;
  zoom: number;
  nextTransition: string;
  certificateError: string | null;
  blocked: number;
  madeFullScreen: boolean;
};

const guests = new Map<number, Guest>();
const attachListeners = new Set<(guest: Guest) => void>();

export const guestById = (id: number): Guest | undefined => guests.get(id);
export const guestOf = (contents: WebContents | null | undefined): Guest | undefined => (contents ? guests.get(contents.id) : undefined);
export const allGuests = (): Guest[] => [...guests.values()];

export function onGuestAttached(listener: (guest: Guest) => void): () => void {
  attachListeners.add(listener);
  return () => void attachListeners.delete(listener);
}

export function tell(guest: Guest, name: string, data: unknown): void {
  if (!guest.attached) {
    guest.waiting.push([name, data]);
    return;
  }
  emit(PAGES_MODULE, "page", { guest: guest.contents.id, name, data });
}

function keepHostWindowed() {
  const hidden = host();
  if (hidden && !hidden.isDestroyed() && hidden.isFullScreen()) hidden.setFullScreen(false);
}

export function windowOf(guest: Guest): BrowserWindow | null {
  const own = guest.windowId ? appWindow(guest.windowId) : undefined;
  if (own && !own.isDestroyed()) return own;
  const embedder = guest.contents.hostWebContents;
  return embedder ? BrowserWindow.fromWebContents(embedder) : null;
}

const levelOf = (url: string, certificateError: string | null) => {
  if (certificateError) return "certificateError";
  if (url.startsWith("https:") || url.startsWith("wss:")) return "secure";
  if (url.startsWith("http:")) return "insecure";
  if (url.startsWith("file:")) return "local";
  return "none";
};

export function securityOf(guest: Guest) {
  const url = guest.committedUrl || guest.url;
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  return {
    level: levelOf(url, guest.certificateError),
    url,
    origin: origin === "null" ? null : origin,
    protocol: url.slice(0, Math.max(0, url.indexOf(":"))),
    ...(guest.certificateError ? { certificateErrors: [guest.certificateError] } : {}),
  };
}

function themeOf(guest: Guest): { themeColor: string | null; themeColorSource: ThemeSource } {
  if (guest.scriptTheme) return { themeColor: guest.scriptTheme.color, themeColorSource: guest.scriptTheme.source };
  return { themeColor: guest.metaTheme, themeColorSource: guest.metaTheme ? "meta" : null };
}

export function navigationOf(guest: Guest) {
  const history = guest.contents.navigationHistory;
  return {
    url: guest.url,
    title: guest.title || guest.contents.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
    isLoading: guest.isLoading,
    ...themeOf(guest),
    committedUrl: guest.committedUrl,
    committedAt: guest.committedAt,
    httpStatus: guest.httpStatus,
  };
}

export const tellNavigation = (guest: Guest) => {
  if (!guest.contents.isDestroyed()) tell(guest, "navigation", navigationOf(guest));
};

function tellProgress(guest: Guest, progress: number) {
  if (progress <= guest.progress && progress !== 0) return;
  guest.progress = progress;
  tell(guest, "progress", { progress });
}

export function tellZoom(guest: Guest, user: boolean) {
  const zoom = guest.contents.getZoomFactor();
  if (!user && Math.abs(zoom - guest.zoom) < 0.001) return;
  guest.zoom = zoom;
  let host = "";
  try {
    host = new URL(guest.url).host;
  } catch {
    host = "";
  }
  tell(guest, "zoom", { zoom, host, isDefault: Math.abs(zoom - 1) < 0.001, pinchScale: 1, user });
}

const CRASH_REASONS: Record<string, string> = {
  "clean-exit": "abnormal",
  "abnormal-exit": "abnormal",
  killed: "killed",
  crashed: "crashed",
  oom: "oom",
  "launch-failed": "launchFailed",
  "integrity-failure": "integrity",
};

function committed(guest: Guest, url: string, status: number) {
  guest.url = url;
  guest.committedUrl = url;
  guest.committedAt = Date.now();
  guest.httpStatus = status;
  guest.scriptTheme = null;
  guest.metaTheme = null;
  guest.certificateError = null;
  if (guest.blocked) tell(guest, "contentBlocked", { count: 0, url });
  guest.blocked = 0;
  tellProgress(guest, 0.5);
  tellNavigation(guest);
  tell(guest, "security", securityOf(guest));
  tellZoom(guest, false);
  emitPage({ type: "navigated", profile: guest.profile, tabId: guest.tabId, url, title: guest.contents.getTitle(), transition: guest.nextTransition, isMainFrame: true });
  guest.nextTransition = "link";
}

function track(contents: WebContents) {
  if (guests.has(contents.id)) return;
  const guest: Guest = {
    contents,
    profile: profileOfSession(contents.session),
    tabId: "",
    windowId: "",
    attached: false,
    waiting: [],
    url: "",
    title: "",
    isLoading: false,
    metaTheme: null,
    scriptTheme: null,
    committedUrl: "",
    committedAt: 0,
    httpStatus: 0,
    progress: 0,
    zoom: 1,
    nextTransition: "link",
    certificateError: null,
    blocked: 0,
    madeFullScreen: false,
  };
  guests.set(contents.id, guest);

  contents.on("did-start-loading", () => {
    guest.isLoading = true;
    guest.progress = 0;
    tellProgress(guest, 0.1);
    tellNavigation(guest);
  });
  let failedLoad: { code: number; text: string; url: string } | null = null;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) failedLoad = null;
  });
  contents.on("did-stop-loading", () => {
    if (failedLoad) void renderErrorPage(contents, failedLoad.code, failedLoad.text, failedLoad.url);
    failedLoad = null;
    guest.isLoading = false;
    tellProgress(guest, 1);
    tellNavigation(guest);
  });
  contents.on("dom-ready", () => tellProgress(guest, 0.8));
  contents.on("did-navigate", (_event, url, status) => committed(guest, url, status));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    guest.url = url;
    tellNavigation(guest);
    emitPage({ type: "navigated", profile: guest.profile, tabId: guest.tabId, url, title: contents.getTitle(), transition: "link", isMainFrame: true });
  });
  contents.on("page-title-updated", (_event, title) => {
    guest.title = title;
    tellNavigation(guest);
    emitPage({ type: "title", profile: guest.profile, tabId: guest.tabId, url: guest.url, title });
  });
  contents.on("page-favicon-updated", (_event, icons) => {
    if (!icons.length) return;
    tell(guest, "favicon", { url: icons[0], urls: icons });
    emitPage({ type: "favicon", profile: guest.profile, tabId: guest.tabId, url: guest.url, icons });
  });
  contents.on("did-change-theme-color", (_event, color) => {
    guest.metaTheme = color;
    if (!guest.scriptTheme) tellNavigation(guest);
  });
  contents.on("did-fail-load", (_event, code, text, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (code <= -200 && code > -300) {
      guest.certificateError = text;
      tell(guest, "security", securityOf(guest));
    }
    tell(guest, "loadError", { url, code, text });
    failedLoad = showsErrorPage(code) ? { code, text, url } : null;
    if (failedLoad && url) {
      guest.url = url;
      guest.committedUrl = url;
      guest.committedAt = Date.now();
      guest.httpStatus = 0;
      tellNavigation(guest);
    }
  });
  contents.on("found-in-page", (_event, result) => {
    tell(guest, "find", { count: result.matches, active: result.activeMatchOrdinal, final: result.finalUpdate });
  });
  contents.on("enter-html-full-screen", () => {
    keepHostWindowed();
    const window = windowOf(guest);
    if (window && !window.isFullScreen()) {
      guest.madeFullScreen = true;
      window.setFullScreen(true);
    }
    tell(guest, "fullscreen", { fullscreen: true });
  });
  contents.on("leave-html-full-screen", () => {
    keepHostWindowed();
    const window = windowOf(guest);
    if (guest.madeFullScreen && window && !window.isDestroyed()) window.setFullScreen(false);
    guest.madeFullScreen = false;
    tell(guest, "fullscreen", { fullscreen: false });
  });
  contents.on("audio-state-changed", (event) => tell(guest, "media", { playing: event.audible, muted: contents.isAudioMuted() }));
  contents.on("update-target-url", (_event, url) => tell(guest, "status", { text: url }));
  contents.on("render-process-gone", (_event, details) => {
    guest.isLoading = false;
    tell(guest, "crashed", { status: details.exitCode, reason: CRASH_REASONS[details.reason] ?? "unknown", code: details.exitCode });
  });
  contents.on("unresponsive", () => tell(guest, "unresponsive", {}));
  contents.on("responsive", () => tell(guest, "responsive", {}));
  contents.on("focus", () => tell(guest, "focus", {}));
  contents.on("input-event", (_event, input) => {
    if (input.type === "mouseDown") tell(guest, "pagePress", {});
  });
  contents.on("zoom-changed", (_event, direction) => {
    stepZoom(guest, direction === "in" ? 1 : -1);
  });
  contents.once("destroyed", () => {
    guests.delete(contents.id);
    const window = guest.madeFullScreen && guest.windowId ? appWindow(guest.windowId) : null;
    if (window && !window.isDestroyed()) window.setFullScreen(false);
    if (guest.tabId) emitPage({ type: "closed", profile: guest.profile, tabId: guest.tabId });
  });
}

export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function stepZoom(guest: Guest, direction: number) {
  const now = guest.contents.getZoomFactor();
  let next = 1;
  if (direction > 0) next = ZOOM_FACTORS.find((factor) => factor > now + 0.001) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  else if (direction < 0) next = [...ZOOM_FACTORS].reverse().find((factor) => factor < now - 0.001) ?? ZOOM_FACTORS[0]!;
  guest.contents.setZoomFactor(next);
  tellZoom(guest, true);
}

function attach(guestId: number, tabId: string, windowId: string): boolean {
  const guest = guests.get(guestId);
  if (!guest) return false;
  guest.tabId = tabId;
  guest.windowId = windowId;
  if (!guest.attached) {
    guest.attached = true;
    const waiting = guest.waiting.splice(0);
    for (const [name, data] of waiting) tell(guest, name, data);
    for (const listener of attachListeners) listener(guest);
  }
  if (guest.url) tellNavigation(guest);
  return true;
}

function moved(guestId: number, windowId: string): void {
  const guest = guests.get(guestId);
  if (guest) guest.windowId = windowId;
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") track(contents);
});

defineModule(PAGES_MODULE, {
  sync: {
    attach: (guestId: number, tabId: string, windowId: string) => attach(guestId, tabId, windowId),
    moved: (guestId: number, windowId: string) => moved(guestId, windowId),
  },
});
