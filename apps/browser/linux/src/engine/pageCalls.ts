import { dialog, nativeImage, type WebContents } from "electron";
import { defineModule } from "../bridge";
import { appWindow } from "../windows";
import { guestById, navigationOf, securityOf, stepZoom, tell, tellNavigation, windowOf, type Guest } from "./guests";
import { sendToPageScript } from "./pageScriptBridge";
import { resolveDisplayMedia } from "./permissions";
import { executeAction } from "../services/extensions";
import { resolvePasswordPrompt } from "../services/pagePasswords";
import { resolveAutofillPrompt } from "../services/pageAutofill";

type Args = Record<string, unknown>;
type PageCall = (guest: Guest, args: Args) => unknown;

const EVALUATE_DEADLINE_MS = 30000;
const quietly = (work: Promise<unknown>) => void work.catch(() => {});
const text = (value: unknown) => (typeof value === "string" ? value : "");

function evaluateWrapper(code: string) {
  return `new Promise((resolve) => {
  const post = (kind, json) => { if (kind === "result") resolve(typeof json === "string" ? json : null); };
  setTimeout(() => resolve(null), ${EVALUATE_DEADLINE_MS});
  try { (function (post) {
${code}
  })(post); } catch (error) { resolve(null); }
})`;
}

async function capture(contents: WebContents, scale: number) {
  const image = await contents.capturePage();
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const shrunk = scale > 0 && scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: "good" }) : image;
  return { data: shrunk.toJPEG(80).toString("base64"), width: size.width, height: size.height };
}

function icoSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  let best = { width: 0, height: 0 };
  const count = bytes.readUInt16LE(4);
  for (let index = 0; index < count && 6 + index * 16 + 16 <= bytes.length; index++) {
    const width = bytes[6 + index * 16] || 256;
    const height = bytes[7 + index * 16] || 256;
    if (width > best.width) best = { width, height };
  }
  return best.width ? best : null;
}

export async function fetchImage(contents: WebContents, url: string, maxPixels: number) {
  if (url.startsWith("data:")) {
    const image = nativeImage.createFromDataURL(url);
    if (!image.isEmpty()) return shaped(image, maxPixels);
    return { uri: url, width: 0, height: 0 };
  }
  const response = await contents.session.fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const image = nativeImage.createFromBuffer(bytes);
  if (!image.isEmpty()) return shaped(image, maxPixels);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() || (url.toLowerCase().endsWith(".ico") ? "image/x-icon" : "");
  if (!type.startsWith("image/")) return null;
  const size = icoSize(bytes) ?? { width: 32, height: 32 };
  return { uri: `data:${type};base64,${bytes.toString("base64")}`, ...size };
}

function shaped(image: Electron.NativeImage, maxPixels: number) {
  let { width, height } = image.getSize();
  let out = image;
  if (maxPixels > 0 && width * height > maxPixels) {
    const ratio = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
    out = image.resize({ width, height, quality: "best" });
  }
  return { uri: out.toDataURL(), width, height };
}

export async function savePage(guest: Guest) {
  const window = windowOf(guest);
  const name = `${(guest.title || "page").replace(/[\\/:*?"<>|]+/g, " ").trim() || "page"}.html`;
  const options = { defaultPath: name, filters: [{ name: "Web page", extensions: ["html", "htm"] }] };
  const chosen = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (chosen.canceled || !chosen.filePath) return;
  await guest.contents.savePage(chosen.filePath, "HTMLComplete");
}

const pageCalls: Record<string, PageCall> = {
  loadUrl: (guest, args) => {
    guest.nextTransition = args.userInitiated === true ? "typed" : "link";
    quietly(guest.contents.loadURL(text(args.url)));
  },
  goBack: (guest) => guest.contents.navigationHistory.goBack(),
  goForward: (guest) => guest.contents.navigationHistory.goForward(),
  goToOffset: (guest, args) => guest.contents.navigationHistory.goToOffset(Number(args.offset) || 0),
  reload: (guest) => {
    guest.nextTransition = "reload";
    guest.contents.reload();
  },
  forceReload: (guest) => {
    guest.nextTransition = "reload";
    guest.contents.reloadIgnoringCache();
  },
  stopLoading: (guest) => guest.contents.stop(),
  setMuted: (guest, args) => {
    guest.contents.setAudioMuted(args.muted === true);
    tell(guest, "media", { playing: guest.contents.isCurrentlyAudible(), muted: guest.contents.isAudioMuted() });
  },
  zoomStep: (guest, args) => stepZoom(guest, Number(args.direction) || 0),
  find: (guest, args) => {
    const query = text(args.text);
    if (query) guest.contents.findInPage(query, { forward: args.forward !== false, findNext: args.findNext !== true });
  },
  stopFinding: (guest, args) => guest.contents.stopFindInPage(args.clear === true ? "clearSelection" : "keepSelection"),
  print: (guest) => guest.contents.print({}),
  runPageCommand: async (guest, args) => {
    if (args.name === "savePage") await savePage(guest);
    else if (args.name === "systemPrint") guest.contents.print({});
  },
  showDevTools: (guest) => guest.contents.openDevTools({ mode: "detach" }),
  inspectAt: (guest, args) => guest.contents.inspectElement(Number(args.x) || 0, Number(args.y) || 0),
  executeJavaScript: async (guest, args) => {
    await guest.contents.executeJavaScript(text(args.code), true).catch(() => null);
  },
  evaluate: async (guest, args) => ({ result: await guest.contents.executeJavaScript(evaluateWrapper(text(args.code)), true).catch(() => null) }),
  navigationEntries: (guest, args) => {
    const history = guest.contents.navigationHistory;
    const current = history.getActiveIndex();
    const withState = args.withState === true;
    return { entries: history.getAllEntries().map((entry, index) => ({ url: entry.url, title: entry.title, current: index === current, ...(withState && entry.pageState ? { pageState: entry.pageState } : {}) })) };
  },
  restoreHistory: async (guest, args) => {
    const entries = Array.isArray(args.entries) ? (args.entries as { url: string; title: string; pageState?: string }[]) : [];
    const index = Number(args.index) || 0;
    if (!entries.length) return false;
    const kept = entries.filter((entry) => entry.url && entry.url !== "about:blank");
    const active = Math.max(0, kept.indexOf(entries[index]!));
    if (!kept.length) return false;
    await guest.contents.navigationHistory.restore({ entries: kept, index: active }).catch((error: unknown) => {
      console.warn(`[ardia linux] the page's history did not carry over: ${String((error as Error)?.message ?? error)}`);
      return guest.contents.loadURL(kept[active]?.url ?? kept[0]!.url).catch(() => {});
    });
    return true;
  },
  capture: (guest, args) => capture(guest.contents, Number(args.scale) || 1),
  downloadImage: (guest, args) => fetchImage(guest.contents, text(args.url), Number(args.maxPixels) || 0).catch(() => null),
  downloadFavicon: (guest, args) => fetchImage(guest.contents, text(args.url), 64 * 64).catch(() => null),
  mediaCommand: (guest, args) => sendToPageScript(guest, "media", { action: args.action, seconds: args.seconds ?? null }),
  getSecurityInfo: (guest) => securityOf(guest),
  pageCookies: async (guest, args) => {
    const urls = Array.isArray(args.urls) ? args.urls.filter((url): url is string => typeof url === "string") : [];
    const lists = await Promise.all(urls.map((url) => guest.contents.session.cookies.get({ url }).catch(() => [])));
    return { cookies: lists.flat() };
  },
  clearSiteData: async (guest) => {
    let origin = "";
    try {
      origin = new URL(guest.url).origin;
    } catch {
      return { cookies: false, storage: false };
    }
    const cookies = await guest.contents.session.cookies.get({ url: origin }).catch(() => []);
    await guest.contents.session.clearStorageData({ origin }).catch(() => null);
    return { cookies: cookies.length, storage: true };
  },
  resolveUnresponsive: (guest, args) => {
    if (args.terminate === true) guest.contents.forcefullyCrashRenderer();
  },
  resolveDisplayMedia: (_guest, args) => resolveDisplayMedia(text(args.id), typeof args.sourceId === "string" ? args.sourceId : null, args.audio === true),
  resolvePasswordPrompt: (guest, args) =>
    resolvePasswordPrompt(guest.contents.id, text(args.answer), {
      ...(typeof args.username === "string" ? { username: args.username } : {}),
      ...(typeof args.password === "string" ? { password: args.password } : {}),
    }),
  resolveAutofillPrompt: (guest, args) => resolveAutofillPrompt(guest.contents.id, Number(args.id), text(args.answer)),
  executeExtensionAction: (guest, args) => executeAction(guest.contents, text(args.extensionId)),
  navigationState: (guest) => navigationOf(guest),
  resendNavigation: (guest) => tellNavigation(guest),
};

async function captureWindow(windowId: string) {
  const window = appWindow(windowId);
  if (!window || window.isDestroyed()) return null;
  const image = await window.webContents.capturePage();
  return image.isEmpty() ? null : image.toPNG().toString("base64");
}

defineModule("ArdiaLinuxPages", {
  async: {
    captureWindow: (windowId: string) => captureWindow(windowId),
    page: async (guestId: number, method: string, args: Args) => {
      const guest = guestById(guestId);
      if (!guest || guest.contents.isDestroyed()) return null;
      const run = pageCalls[method];
      if (!run) throw Object.assign(new Error(`<ArdiaWebView>.${method} is not on Linux yet`), { code: "ERR_ENGINE" });
      return (await run(guest, args ?? {})) ?? null;
    },
  },
});
