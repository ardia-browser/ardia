import { BaseWindow, screen, WebContentsView, type BrowserWindowConstructorOptions, type Rectangle, type Session, type WebContents } from "electron";
import { join } from "node:path";
import { keepOutOfAppWindows } from "../menus/keyboard";
import { isBackground } from "../paths";

export const ORIGIN_STRIP_HEIGHT = 28;
const DEFAULT_SIZE = { width: 500, height: 600 };
const MIN_SIZE = { width: 200, height: 150 };
const PARENT_TOP_GAP = 60;
const OPEN_AS_TAB = "ardia-open-as-tab";
const PAGE_PRELOAD = "page-preload.js";

export type PopupFeatures = { width?: number; height?: number; left?: number; top?: number };

type PopupOptions = {
  features: PopupFeatures;
  parent: BaseWindow | null;
  openAsTab: (url: string) => void;
  wire: (contents: WebContents) => void;
};

type Security = "secure" | "insecure" | "certificateError" | "none";

const popups = new Set<BaseWindow>();

export const popupWindowCount = (): number => popups.size;

export function parseFeatures(features: string): PopupFeatures {
  const parsed: PopupFeatures = {};
  for (const part of features.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = Number.parseInt(rawValue?.trim() ?? "", 10);
    if (!key || !Number.isFinite(value)) continue;
    if (key === "width" || key === "innerwidth") parsed.width = value;
    else if (key === "height" || key === "innerheight") parsed.height = value;
    else if (key === "left" || key === "screenx") parsed.left = value;
    else if (key === "top" || key === "screeny") parsed.top = value;
  }
  return parsed;
}

export function originText(url: string): string {
  if (!url) return "about:blank";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "blob:" || parsed.protocol === "filesystem:") return originText(parsed.pathname);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host;
    if (parsed.protocol === "file:") return "file://";
    return `${parsed.protocol}`;
  } catch {
    const colon = url.indexOf(":");
    return colon < 0 ? url : url.slice(0, colon + 1);
  }
}

function securityOfUrl(url: string, certificateError: boolean): Security {
  if (certificateError) return "certificateError";
  if (url.startsWith("https:") || url.startsWith("wss:")) return "secure";
  if (url.startsWith("http:") || url.startsWith("ws:")) return "insecure";
  return "none";
}

function placement(features: PopupFeatures, parent: BaseWindow | null): Rectangle {
  const width = Math.max(features.width ?? DEFAULT_SIZE.width, MIN_SIZE.width);
  const height = Math.max(features.height ?? DEFAULT_SIZE.height, MIN_SIZE.height) + ORIGIN_STRIP_HEIGHT;
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const display = parentBounds ? screen.getDisplayMatching(parentBounds) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const fitted = { width: Math.min(width, area.width), height: Math.min(height, area.height) };
  let x: number;
  let y: number;
  if (features.left !== undefined || features.top !== undefined) {
    x = features.left ?? (parentBounds ? parentBounds.x + (parentBounds.width - fitted.width) / 2 : area.x);
    y = features.top ?? (parentBounds ? parentBounds.y + PARENT_TOP_GAP : area.y);
  } else if (parentBounds) {
    x = parentBounds.x + (parentBounds.width - fitted.width) / 2;
    y = parentBounds.y + PARENT_TOP_GAP;
  } else {
    x = area.x + (area.width - fitted.width) / 2;
    y = area.y + (area.height - fitted.height) / 2;
  }
  x = Math.max(area.x, Math.min(Math.round(x), area.x + area.width - fitted.width));
  y = Math.max(area.y, Math.min(Math.round(y), area.y + area.height - fitted.height));
  return { x, y, ...fitted };
}

const LOCK = `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 7zm1.5 0h4V5a2 2 0 0 0-4 0z"/></svg>`;
const OPEN_LOCK = `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M2 9.5A1.5 1.5 0 0 1 3.5 8H9V5.5a3.25 3.25 0 0 1 6.5 0V7H14V5.5a1.75 1.75 0 0 0-3.5 0V8h.5A1.5 1.5 0 0 1 12.5 9.5v4A1.5 1.5 0 0 1 11 15H3.5A1.5 1.5 0 0 1 2 13.5z"/></svg>`;
const INFO = `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm0 1.3a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8 2.8zM7.3 7h1.4v4.5H7.3zM8 4.4a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7z"/></svg>`;

const stripPage = () => `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#f4f4f4;--text:#1d1d1f;--muted:#6e6e73;--edge:rgba(0,0,0,.12);--hover:rgba(0,0,0,.07);--warn:#ff5f57}
@media (prefers-color-scheme:dark){:root{--bg:#262626;--text:#f2f2f2;--muted:#9a9a9f;--edge:rgba(255,255,255,.12);--hover:rgba(255,255,255,.09)}}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font:12px system-ui,-apple-system,"Segoe UI",Ubuntu,Cantarell,sans-serif;user-select:none;cursor:default}
body{display:flex;align-items:center;gap:5px;padding:0 6px 0 10px;box-sizing:border-box;border-bottom:1px solid var(--edge);-webkit-app-region:drag}
#glyph{width:16px;height:16px;display:flex;align-items:center;justify-content:center;color:var(--muted);flex:none}
#glyph.danger{color:var(--warn)}
#origin{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left}
#origin span{direction:ltr;unicode-bidi:bidi-override}
button{-webkit-app-region:no-drag;flex:none;border:0;background:transparent;color:var(--muted);font:inherit;padding:3px 8px;border-radius:6px}
button:hover{background:var(--hover);color:var(--text)}
</style></head><body><div id="glyph"></div><div id="origin"><span></span></div><button id="tab" title="Open this page as a tab in your window">Open as Tab</button>
<script>
const glyphs = { secure: ${JSON.stringify(LOCK)}, insecure: ${JSON.stringify(OPEN_LOCK)}, certificateError: ${JSON.stringify(OPEN_LOCK)}, none: ${JSON.stringify(INFO)} };
const labels = { secure: "Connection is secure", insecure: "Connection is not secure", certificateError: "Connection is not secure", none: "Local or internal page" };
let presses = 0;
window.showOrigin = (text, level) => {
  const glyph = document.getElementById("glyph");
  glyph.innerHTML = glyphs[level] || glyphs.none;
  glyph.title = labels[level] || labels.none;
  glyph.className = level === "certificateError" ? "danger" : "";
  document.querySelector("#origin span").textContent = text;
};
document.getElementById("tab").onclick = () => { document.title = ${JSON.stringify(OPEN_AS_TAB)} + ":" + ++presses; };
</script></body></html>`;

export function pagePreferences(session: Session): Electron.WebPreferences {
  return {
    session,
    preload: join(__dirname, PAGE_PRELOAD),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: true,
  };
}

function hostPage(window: BaseWindow, page: WebContentsView, options: PopupOptions) {
  const strip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
  window.contentView.addChildView(page);
  window.contentView.addChildView(strip);
  const layout = () => {
    if (window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    strip.setBounds({ x: 0, y: 0, width, height: ORIGIN_STRIP_HEIGHT });
    page.setBounds({ x: 0, y: ORIGIN_STRIP_HEIGHT, width, height: Math.max(height - ORIGIN_STRIP_HEIGHT, 0) });
  };
  layout();
  window.on("resize", layout);

  const contents = page.webContents;
  keepOutOfAppWindows(contents);
  keepOutOfAppWindows(strip.webContents);
  options.wire(contents);
  let certificateError = false;
  let stripReady = false;
  const describe = () => {
    if (window.isDestroyed() || contents.isDestroyed()) return;
    const url = contents.getURL();
    const title = contents.getTitle();
    window.setTitle(title && title !== url && title !== "about:blank" ? title : originText(url));
    if (stripReady && !strip.webContents.isDestroyed())
      void strip.webContents.executeJavaScript(`showOrigin(${JSON.stringify(originText(url))}, ${JSON.stringify(securityOfUrl(url, certificateError))})`).catch(() => {});
  };
  strip.webContents.once("did-finish-load", () => {
    stripReady = true;
    describe();
  });
  strip.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (!title.startsWith(`${OPEN_AS_TAB}:`) || contents.isDestroyed()) return;
    const url = contents.getURL();
    if (url && url !== "about:blank") options.openAsTab(url);
    window.close();
  });
  void strip.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(stripPage())}`);

  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) certificateError = false;
  });
  contents.on("did-fail-load", (_event, code, _text, _url, isMainFrame) => {
    if (isMainFrame && code <= -200 && code > -300) certificateError = true;
    describe();
  });
  contents.on("did-navigate", describe);
  contents.on("did-navigate-in-page", describe);
  contents.on("page-title-updated", describe);
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if ((input.control || input.meta) && !input.alt && !input.shift && key === "w") {
      event.preventDefault();
      window.close();
    }
  });
  contents.once("destroyed", () => {
    if (!window.isDestroyed()) window.close();
  });
  window.once("closed", () => {
    popups.delete(window);
    if (!contents.isDestroyed()) contents.close();
    if (!strip.webContents.isDestroyed()) strip.webContents.close();
  });
  window.on("focus", () => {
    if (!contents.isDestroyed()) contents.focus();
  });
  describe();
}

function makeWindow(options: PopupOptions): BaseWindow {
  const bounds = placement(options.features, options.parent);
  const window = new BaseWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height + ORIGIN_STRIP_HEIGHT,
    show: false,
    title: "",
    backgroundColor: "#ffffff",
  });
  popups.add(window);
  return window;
}

function reveal(window: BaseWindow, page: WebContentsView) {
  if (isBackground() || window.isDestroyed()) return;
  window.show();
  page.webContents.focus();
}

export function popupWindowCreator(options: PopupOptions): (constructor: BrowserWindowConstructorOptions) => WebContents {
  return (constructor) => {
    const window = makeWindow(options);
    const page = new WebContentsView({ webContents: (constructor as { webContents?: WebContents }).webContents, webPreferences: constructor.webPreferences });
    hostPage(window, page, options);
    reveal(window, page);
    return page.webContents;
  };
}

export function openPopupWindow(url: string, session: Session, options: PopupOptions): WebContents {
  const window = makeWindow(options);
  const page = new WebContentsView({ webPreferences: pagePreferences(session) });
  hostPage(window, page, options);
  reveal(window, page);
  void page.webContents.loadURL(url).catch(() => {});
  return page.webContents;
}
