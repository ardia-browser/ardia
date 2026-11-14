import { BrowserWindow, Menu, screen, type BrowserWindowConstructorOptions, type ContextMenuParams, type MenuItemConstructorOptions, type Rectangle, type WebContents } from "electron";
import { defineModule, emit } from "../bridge";
import { isBackground } from "../paths";
import { isQuitting, replyToTerminate, requestQuit } from "../quit";
import { appWindow, appWindowIds, auxiliaryWindow, onAppWindowCreated, shapeNextAuxiliaryWindow, shapeNextWindow } from "../windows";

type Frame = [number, number, number, number];
type Kind = "browser" | "small" | "settings" | "import";
type OpenOptions = { frame?: Frame | null; kind?: Kind; size?: [number, number]; focus?: boolean; title?: string; behind?: string; incognito?: boolean };
type WindowEvent = Record<string, unknown> & { type: string; id: string };

const MODULE = "ArdiaAppWindows";
const CORNER_RADIUS = 19;
const FRAME_CORNER_RADIUS = 12;
const CASCADE_STEP = 28;
const DRAG_TICK_MS = 8;
const FRAME_SETTLE_MS = 120;
const LAST_WINDOW_GRACE_MS = 400;

const SIZES: Record<Kind, { width: number; height: number; minWidth: number; minHeight: number }> = {
  browser: { width: 1280, height: 800, minWidth: 480, minHeight: 360 },
  small: { width: 900, height: 640, minWidth: 420, minHeight: 300 },
  settings: { width: 820, height: 640, minWidth: 720, minHeight: 480 },
  import: { width: 640, height: 600, minWidth: 640, minHeight: 600 },
};

const kinds = new Map<string, Kind>();
const wantsFocus = new Map<string, boolean>();
const closingByApp = new Set<string>();
const frameTimers = new Map<string, ReturnType<typeof setTimeout>>();
let lastBrowser: string | null = null;
let drag: { id: string; grab: { x: number; y: number }; timer: ReturnType<typeof setInterval> } | null = null;

const windowEvent = (event: WindowEvent) => emit(MODULE, "onWindowEvent", event);
const isBrowserKind = (kind: Kind | undefined) => kind === "browser" || kind === "small";

const flipHeight = () => screen.getPrimaryDisplay().bounds.height;
const frameOf = (bounds: Rectangle): Frame => [bounds.x, flipHeight() - (bounds.y + bounds.height), bounds.width, bounds.height];
const boundsOf = (frame: Frame): Rectangle => ({ x: frame[0], y: flipHeight() - (frame[1] + frame[3]), width: frame[2], height: frame[3] });

function placement(id: string, kind: Kind, options: OpenOptions): Rectangle {
  const asked = options.frame && options.frame[2] > 0 && options.frame[3] > 0 ? boundsOf(options.frame) : null;
  const sizes = SIZES[kind];
  if (asked) {
    const area = screen.getDisplayMatching(asked).workArea;
    const width = Math.min(Math.max(asked.width, sizes.minWidth), area.width);
    const height = Math.min(Math.max(asked.height, sizes.minHeight), area.height);
    const x = Math.max(area.x, Math.min(asked.x, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(asked.y, area.y + area.height - height));
    return { x, y, width, height };
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const size = kind === "small" && options.size ? { width: options.size[0], height: options.size[1] } : sizes;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  let x = area.x + Math.round((area.width - width) / 2);
  let y = area.y + Math.round((area.height - height) / 2);
  const previous = kind === "browser" && lastBrowser && lastBrowser !== id ? appWindow(lastBrowser) : undefined;
  if (previous && !previous.isDestroyed() && previous.isVisible()) {
    const at = previous.getBounds();
    x = Math.min(at.x + CASCADE_STEP, area.x + area.width - width);
    y = Math.min(at.y + CASCADE_STEP, area.y + area.height - height);
  }
  return { x, y, width, height };
}

function shapeWindow(id: string, options: OpenOptions = {}) {
  const kind: Kind = options.kind ?? "browser";
  kinds.set(id, kind);
  wantsFocus.set(id, options.focus !== false);
  const bounds = placement(id, kind, options);
  const sizes = SIZES[kind];
  const utility = !isBrowserKind(kind);
  const shaped: BrowserWindowConstructorOptions = {
    ...bounds,
    minWidth: Math.min(sizes.minWidth, bounds.width),
    minHeight: Math.min(sizes.minHeight, bounds.height),
    title: options.title || "Ardia",
    resizable: kind !== "import",
    maximizable: kind !== "import",
    minimizable: true,
    fullscreenable: !utility,
  };
  shapeNextWindow(id, shaped);
}

function showWindow(id: string) {
  const window = appWindow(id);
  if (!window || window.isDestroyed() || window.isVisible()) return;
  if (wantsFocus.get(id) === false || isBackground()) window.showInactive();
  else {
    window.show();
    window.focus();
  }
}

function emitFrameSoon(id: string, window: BrowserWindow) {
  clearTimeout(frameTimers.get(id));
  frameTimers.set(
    id,
    setTimeout(() => {
      frameTimers.delete(id);
      if (window.isDestroyed() || window.isMaximized() || window.isFullScreen() || window.isMinimized()) return;
      windowEvent({ type: "frame", id, frame: frameOf(window.getBounds()) });
    }, FRAME_SETTLE_MS),
  );
}

function editMenu(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  const spelling: MenuItemConstructorOptions[] = params.misspelledWord
    ? [
        ...params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
        ...(params.dictionarySuggestions.length ? [] : [{ label: "No Guesses Found", enabled: false }]),
        { label: "Learn Spelling", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: "separator" },
      ]
    : [];
  if (!params.isEditable) return params.selectionText ? [{ label: "Copy", role: "copy" }] : [];
  return [
    ...spelling,
    { label: "Undo", role: "undo", enabled: flags.canUndo },
    { label: "Redo", role: "redo", enabled: flags.canRedo },
    { type: "separator" },
    { label: "Cut", role: "cut", enabled: flags.canCut },
    { label: "Copy", role: "copy", enabled: flags.canCopy },
    { label: "Paste", role: "paste", enabled: flags.canPaste },
    { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: flags.canPaste },
    { label: "Delete", role: "delete", enabled: flags.canDelete },
    { type: "separator" },
    { label: "Select All", role: "selectAll", enabled: flags.canSelectAll },
  ];
}

function offerEditMenu(window: BrowserWindow) {
  window.webContents.on("context-menu", (_event, params) => {
    const items = editMenu(window.webContents, params);
    if (!items.length) return;
    const menu = Menu.buildFromTemplate(items);
    if (isBackground()) {
      console.info(`[ardia linux] edit menu (not shown): ${menu.items.filter((item) => item.type !== "separator").map((item) => item.label).join(" | ")}`);
      return;
    }
    menu.popup({ window });
  });
}

function watch(id: string, window: BrowserWindow) {
  offerEditMenu(window);
  if (kinds.get(id) === "browser") lastBrowser = id;
  window.on("focus", () => {
    if (kinds.get(id) === "browser") lastBrowser = id;
    windowEvent({ type: "focus", id });
  });
  window.on("move", () => emitFrameSoon(id, window));
  window.on("resize", () => emitFrameSoon(id, window));
  window.on("maximize", () => windowEvent({ type: "maximized", id, on: true }));
  window.on("unmaximize", () => windowEvent({ type: "maximized", id, on: false }));
  window.on("enter-full-screen", () => windowEvent({ type: "fullScreen", id, on: true }));
  window.on("leave-full-screen", () => windowEvent({ type: "fullScreen", id, on: false }));
  window.on("close", (event) => {
    if (closingByApp.has(id) || isQuitting() || !isBrowserKind(kinds.get(id))) return;
    event.preventDefault();
    windowEvent({ type: "closeRequest", id });
  });
  window.once("closed", () => {
    closingByApp.delete(id);
    clearTimeout(frameTimers.get(id));
    frameTimers.delete(id);
    if (drag?.id === id) endWindowDrag();
    if (lastBrowser === id) lastBrowser = null;
    windowEvent({ type: "close", id });
    quitWhenNoWindowsAreLeft();
  });
}

function quitWhenNoWindowsAreLeft() {
  if (isQuitting()) return;
  setTimeout(() => {
    if (!appWindowIds().length) requestQuit();
  }, LAST_WINDOW_GRACE_MS);
}

function closeWindow(id: string) {
  const window = appWindow(id);
  if (!window || window.isDestroyed()) return;
  closingByApp.add(id);
  window.close();
}

function focusWindow(id: string) {
  const window = appWindow(id);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function toggleMaximizeWindow(id: string) {
  const window = appWindow(id);
  if (!window || window.isDestroyed() || !window.isMaximizable()) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

function beginWindowDrag(id: string, pressedX?: number, pressedY?: number) {
  const window = appWindow(id);
  if (!window || window.isDestroyed() || window.isFullScreen()) return;
  endWindowDrag();
  const cursor = typeof pressedX === "number" && typeof pressedY === "number" ? { x: pressedX, y: pressedY } : screen.getCursorScreenPoint();
  let bounds = window.getBounds();
  if (window.isMaximized()) {
    const share = (cursor.x - bounds.x) / Math.max(1, bounds.width);
    window.unmaximize();
    const restored = window.getBounds();
    bounds = { ...restored, x: Math.round(cursor.x - share * restored.width), y: bounds.y };
    window.setBounds(bounds);
  }
  const grab = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  const timer = setInterval(() => {
    if (window.isDestroyed()) return endWindowDrag();
    const now = screen.getCursorScreenPoint();
    const [x, y] = window.getPosition();
    const nextX = now.x - grab.x;
    const nextY = now.y - grab.y;
    if (x !== nextX || y !== nextY) window.setPosition(nextX, nextY);
  }, DRAG_TICK_MS);
  drag = { id, grab, timer };
}

function endWindowDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
}

function restoreFullScreen(ids: string[], focus: string | null) {
  for (const id of ids) appWindow(id)?.setFullScreen(true);
  if (focus) focusWindow(focus);
}

function setPageFullScreen(id: string, on: boolean) {
  const window = appWindow(id);
  if (window && !window.isDestroyed() && window.isFullScreen() !== on) window.setFullScreen(on);
}

const DRAG_PREVIEW = "ardia-drag-preview";

function shapeDragPreview() {
  shapeNextAuxiliaryWindow(DRAG_PREVIEW, {
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
  });
}

function moveDragPreview(source: string, left: number, top: number, width: number, height: number) {
  const preview = auxiliaryWindow(DRAG_PREVIEW);
  const from = appWindow(source);
  if (!preview || preview.isDestroyed() || !from || from.isDestroyed()) return;
  const origin = from.getContentBounds();
  preview.setIgnoreMouseEvents(true);
  preview.setBounds({ x: Math.round(origin.x + left), y: Math.round(origin.y + top), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
  if (!preview.isVisible()) preview.showInactive();
}

function hideDragPreview() {
  const preview = auxiliaryWindow(DRAG_PREVIEW);
  if (preview && !preview.isDestroyed()) preview.hide();
}

function dragPreviewBounds(): Rectangle | null {
  const preview = auxiliaryWindow(DRAG_PREVIEW);
  return preview && !preview.isDestroyed() && preview.isVisible() ? preview.getBounds() : null;
}

function placeDragPreview(x: number, y: number, width: number, height: number) {
  const preview = auxiliaryWindow(DRAG_PREVIEW);
  if (!preview || preview.isDestroyed()) return;
  preview.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
  if (!preview.isVisible()) preview.showInactive();
}

function dragPreviewTarget(id: string | null, fallback: Frame | null): { bounds: Rectangle; shown: boolean; found: boolean } | null {
  const window = id ? appWindow(id) : undefined;
  if (window && !window.isDestroyed()) return { bounds: window.getBounds(), shown: window.isVisible(), found: true };
  return fallback && fallback[2] > 0 && fallback[3] > 0 ? { bounds: boundsOf(fallback), shown: false, found: false } : null;
}

async function snapshotWindow(id: string): Promise<{ url: string; width: number; height: number } | null> {
  const window = appWindow(id);
  if (!window || window.isDestroyed() || !window.isVisible()) return null;
  const image = await window.webContents.capturePage();
  if (image.isEmpty() || window.isDestroyed()) return null;
  const { width, height } = window.getContentBounds();
  return { url: image.toDataURL(), width, height };
}

onAppWindowCreated((id, window) => watch(id, window));

defineModule(MODULE, {
  constants: { cornerRadius: CORNER_RADIUS },
  sync: {
    shapeWindow: (id: string, options: OpenOptions) => shapeWindow(id, options),
    showWindow: (id: string) => showWindow(id),
    windowCornerRadius: () => CORNER_RADIUS,
    shapeDragPreview: () => shapeDragPreview(),
    moveDragPreview: (source: string, left: number, top: number, width: number, height: number) => moveDragPreview(source, left, top, width, height),
    hideDragPreview: () => hideDragPreview(),
    dragPreviewBounds: () => dragPreviewBounds(),
    placeDragPreview: (x: number, y: number, width: number, height: number) => placeDragPreview(x, y, width, height),
    dragPreviewTarget: (id: string | null, fallback: Frame | null) => dragPreviewTarget(id, fallback),
    isMaximized: (id: string) => !!appWindow(id)?.isMaximized(),
    debugWindowState: (id: string) => {
      const window = appWindow(id);
      if (!window || window.isDestroyed()) return null;
      return { visible: window.isVisible(), minimized: window.isMinimized(), maximized: window.isMaximized(), fullScreen: window.isFullScreen(), focused: window.isFocused(), frame: frameOf(window.getBounds()), bounds: window.getBounds() };
    },
  },
  async: {
    closeWindow: async (id: string) => closeWindow(id),
    focusWindow: async (id: string) => focusWindow(id),
    minimizeWindow: async (id: string) => appWindow(id)?.minimize(),
    toggleMaximizeWindow: async (id: string) => toggleMaximizeWindow(id),
    setCaptionRegions: async () => {},
    setTrafficLightsCenter: async () => {},
    windowFrame: async (id: string): Promise<Frame | null> => {
      const window = appWindow(id);
      return window && !window.isDestroyed() ? frameOf(window.getBounds()) : null;
    },
    frameCornerRadius: async (id: string) => (appWindow(id)?.isMaximized() || appWindow(id)?.isFullScreen() ? 0 : FRAME_CORNER_RADIUS),
    windowIds: async () => appWindowIds(),
    snapshotWindow: async (id: string) => snapshotWindow(id),
    setWindowTitle: async (id: string, title: string) => appWindow(id)?.setTitle(title || "Ardia"),
    restoreFullScreen: async (ids: string[], focus: string | null) => restoreFullScreen(ids, focus),
    setPageFullScreen: async (id: string, on: boolean) => setPageFullScreen(id, on),
    beginWindowDrag: async (id: string, pressedX?: number, pressedY?: number) => beginWindowDrag(id, pressedX, pressedY),
    endWindowDrag: async () => endWindowDrag(),
    quit: async () => requestQuit(),
    replyToTerminate: async (ok: boolean) => replyToTerminate(ok),
    raiseView: async () => {},
  },
});
