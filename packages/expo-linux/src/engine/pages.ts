import { linuxBridge, pagesCall, pagesCallSync, PAGES_MODULE } from "./linuxBridge";
import { keepPagesOnMoveIn, moveWithin, parkingLotOf } from "./pageMoves";
import { noteLoadAsked, openingPage, shapedPageEvent, type OpeningPage } from "./pageEvents";

type WebviewElement = HTMLElement & { getWebContentsId(): number };

export type PageSink = (name: string, data: unknown) => void;
export type PageStart = { url?: string; profile?: string; tabId?: string; windowId: string; background?: string };

type HistoryEntry = { url: string; title: string; pageState?: string };
type History = { entries: HistoryEntry[]; index: number };

type Page = {
  key: string;
  start: PageStart;
  element: WebviewElement;
  guestId: number;
  attached: Promise<number>;
  settle: (guestId: number) => void;
  opening: OpeningPage;
  sink: PageSink | null;
  parked: boolean;
  closed: boolean;
  history: Promise<History | null> | null;
  visible: boolean;
  started: { url: string; at: number };
  sleeping: History | null;
  holder: HTMLElement | null;
};

export type DiscardOutcome = "discarded" | "already" | "refused" | "unsupported";
type DiscardReason = "external" | "proactive" | "urgent";

const BLANK = "about:blank";
const PASSWORDS_MODULE = "ArdiaLinuxPasswords";
const RESTORES_HISTORY = "about:blank#ardia-restores-history";
const PRIVATE_MARK = "@";
const GUEST_ID_POLL_MS = 16;
const SAME_LOAD_MS = 2000;
const GUEST_ID_DEADLINE_MS = 5000;

const pages = new Map<string, Page>();
const byGuest = new Map<number, Page>();
let listening = false;

const quietly = (work: Promise<unknown>) => void work.catch(() => {});
const WAKING_CALLS = new Set(["reload", "forceReload", "loadUrl", "goBack", "goForward", "goToOffset"]);

function fallbackPartition(profile: string) {
  if (profile.includes(PRIVATE_MARK)) return `ardia-private-${encodeURIComponent(profile)}`;
  return profile ? `persist:ardia-${encodeURIComponent(profile)}` : "persist:ardia";
}

const partitionOf = (profile: string) => pagesCallSync<string>("partitionOf", profile) ?? fallbackPartition(profile);

type Point = { x: number; y: number };

const isPoint = (value: unknown): value is Point =>
  typeof value === "object" && value !== null && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

function placedInWindow(page: Page, name: string, data: unknown): unknown {
  const point = name === "openWindow" ? (data as { point?: unknown } | null)?.point : undefined;
  if (!isPoint(point)) return data;
  const rect = page.element.getBoundingClientRect();
  return { ...(data as object), point: { x: rect.left + point.x, y: rect.top + point.y } };
}

function deliver(page: Page, name: string, data: unknown) {
  if (page.closed) return;
  const shaped = shapedPageEvent(page.opening, name, placedInWindow(page, name, data));
  page.sink?.(name, shaped);
}

function listen() {
  if (listening) return;
  const bridge = linuxBridge();
  if (!bridge) return;
  listening = true;
  bridge.onEvent((module, event, payload) => {
    if (module === PASSWORDS_MODULE && event === "prompt") return promptToSave(payload);
    if (module === PAGES_MODULE && event === "discard") return discardAsked(payload);
    if (module !== PAGES_MODULE || event !== "page") return;
    const { guest, name, data } = (payload ?? {}) as { guest?: number; name?: string; data?: unknown };
    const page = typeof guest === "number" ? byGuest.get(guest) : undefined;
    if (page && typeof name === "string" && page.guestId === guest) deliver(page, name, data);
  });
}

function discardAsked(payload: unknown) {
  const { guest, reason } = (payload ?? {}) as { guest?: number; reason?: string };
  const page = typeof guest === "number" ? byGuest.get(guest) : undefined;
  if (page) void discard(page, reason === "urgent" ? "urgent" : "proactive");
}

function promptToSave(payload: unknown) {
  const { webContentsId, prompt } = (payload ?? {}) as { webContentsId?: number; prompt?: unknown };
  const page = typeof webContentsId === "number" ? byGuest.get(webContentsId) : undefined;
  if (page && prompt) deliver(page, "passwordPrompt", prompt);
}

const windowIdOf = (doc: Document) => doc.defaultView?.name ?? "";

function readyPromise(page: Pick<Page, "settle">): Promise<number> {
  return new Promise<number>((resolve) => {
    page.settle = resolve;
  });
}

function restoreInto(page: Page, guestId: number, history: Promise<History | null>, fallbackUrl: string) {
  quietly(
    history.then((kept) => {
      if (page.closed || page.guestId !== guestId) return;
      const usable = kept && kept.entries.some((entry) => entry.url && entry.url !== BLANK);
      if (usable) return pagesCall("page", guestId, "restoreHistory", kept);
      if (fallbackUrl && fallbackUrl !== BLANK) return pagesCall("page", guestId, "loadUrl", { url: fallbackUrl, userInitiated: false });
      return null;
    }),
  );
}

function makeElement(doc: Document, page: Page, src: string, history: Promise<History | null> | null): WebviewElement {
  const element = doc.createElement("webview") as WebviewElement;
  element.setAttribute("partition", partitionOf(page.start.profile ?? ""));
  element.setAttribute("allowpopups", "");
  element.setAttribute("src", src || BLANK);
  element.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:flex;border:0;outline:none;";
  if (page.start.background) element.style.background = page.start.background;
  const fallbackUrl = page.start.url ?? "";
  element.addEventListener("did-attach", () => {
    void guestIdOf(element).then((guestId) => {
      if (guestId) attached(page, element, guestId, history, fallbackUrl);
    });
  });
  element.addEventListener("close", () => {
    if (page.element === element) deliver(page, "windowClose", {});
  });
  return element;
}

function readGuestId(element: WebviewElement): number {
  try {
    return element.getWebContentsId();
  } catch {
    return 0;
  }
}

async function guestIdOf(element: WebviewElement): Promise<number> {
  for (let waited = 0; waited < GUEST_ID_DEADLINE_MS; waited += GUEST_ID_POLL_MS) {
    const id = readGuestId(element);
    if (id) return id;
    if (!element.isConnected) return 0;
    await new Promise((resolve) => setTimeout(resolve, GUEST_ID_POLL_MS));
  }
  return readGuestId(element);
}

function attached(page: Page, element: WebviewElement, guestId: number, history: Promise<History | null> | null, fallbackUrl: string) {
  if (page.element !== element || page.closed) return;
  page.guestId = guestId;
  byGuest.set(guestId, page);
  pagesCallSync("attach", guestId, page.start.tabId || page.key, page.start.windowId);
  if (!page.visible) pagesCallSync("shown", guestId, false);
  if (history) restoreInto(page, guestId, history, fallbackUrl);
  page.settle(guestId);
  deliver(page, "ready", {});
}

function applyVisibility(page: Page) {
  const { element } = page;
  element.style.visibility = page.visible ? "" : "hidden";
  if (!page.visible && element.ownerDocument.activeElement === element) element.blur();
}

function createPage(key: string, start: PageStart, holder: HTMLElement): Page {
  const page = {
    key,
    start,
    guestId: 0,
    opening: openingPage(start.url ?? ""),
    sink: null,
    parked: false,
    closed: false,
    history: null,
    visible: true,
    started: { url: start.url ?? "", at: Date.now() },
    sleeping: null,
    holder: null,
  } as unknown as Page;
  page.attached = readyPromise(page);
  page.element = makeElement(holder.ownerDocument, page, start.url ?? "", null);
  holder.appendChild(page.element);
  return page;
}

function rebuildIn(page: Page, holder: HTMLElement, start: PageStart) {
  const old = page.element;
  const oldGuest = page.guestId;
  const asleep = page.sleeping;
  page.sleeping = null;
  page.holder = null;
  const history = asleep ? Promise.resolve(asleep) : page.history ?? (oldGuest ? pagesCall<{ entries: (HistoryEntry & { current: boolean })[] }>("page", oldGuest, "navigationEntries", { withState: true }).then(asHistory) : Promise.resolve(null));
  page.start = { ...page.start, ...start, url: page.start.url };
  page.started = { url: start.url ?? "", at: Date.now() };
  page.history = null;
  page.guestId = 0;
  const settleWaiting = page.settle;
  page.attached = readyPromise(page);
  void page.attached.then(settleWaiting);
  page.element = makeElement(holder.ownerDocument, page, RESTORES_HISTORY, history);
  holder.appendChild(page.element);
  applyVisibility(page);
  if (oldGuest) byGuest.delete(oldGuest);
  quietly(history.finally(() => old.remove()));
}

function asHistory(reply: { entries: (HistoryEntry & { current: boolean })[] } | null): History | null {
  const entries = reply?.entries ?? [];
  if (!entries.length) return null;
  const index = Math.max(0, entries.findIndex((entry) => entry.current));
  return { entries: entries.map(({ url, title, pageState }) => ({ url, title, ...(pageState ? { pageState } : {}) })), index };
}

function close(page: Page) {
  if (page.closed) return;
  page.closed = true;
  if (pages.get(page.key) === page) pages.delete(page.key);
  if (page.guestId) byGuest.delete(page.guestId);
  page.settle(0);
  page.sink = null;
  page.element.remove();
}

export function mountPage(key: string, start: PageStart, sink: PageSink, holder: HTMLElement): () => void {
  listen();
  const realm = holder.ownerDocument.defaultView;
  if (realm) keepPagesOnMoveIn(realm as Window & typeof globalThis);
  const windowId = start.windowId || windowIdOf(holder.ownerDocument);
  const wanted = { ...start, windowId };
  let page = pages.get(key);
  if (page && !page.closed) {
    page.parked = false;
    if (page.element.ownerDocument === holder.ownerDocument && page.element.isConnected && moveWithin(holder, page.element)) {
      if (page.start.windowId !== windowId && page.guestId) pagesCallSync("moved", page.guestId, windowId);
      page.start = { ...page.start, windowId };
    } else rebuildIn(page, holder, wanted);
    page.history = null;
  } else {
    page = createPage(key, wanted, holder);
    pages.set(key, page);
  }
  const mounted = page;
  mounted.sink = sink;
  if (mounted.guestId) {
    const ready = mounted.guestId;
    queueMicrotask(() => {
      if (mounted.sink === sink && mounted.guestId === ready) {
        sink("ready", {});
        quietly(pagesCall("page", ready, "resendNavigation", {}));
      }
    });
  }
  return () => {
    if (mounted.sink === sink) mounted.sink = null;
    if (mounted.closed) return;
    if (mounted.parked && mounted.element.isConnected) {
      if (moveWithin(parkingLotOf(mounted.element.ownerDocument), mounted.element)) return;
    }
    close(mounted);
  };
}

export function setPageVisible(key: string, visible: boolean) {
  const page = pages.get(key);
  if (!page || page.closed || page.visible === visible) return;
  page.visible = visible;
  if (visible && page.sleeping) wake(page, null);
  applyVisibility(page);
  if (page.guestId) pagesCallSync("shown", page.guestId, visible);
}

const currentUrl = (history: History | null) => history?.entries[history.index]?.url ?? "";

async function discard(page: Page, reason: DiscardReason): Promise<DiscardOutcome> {
  if (page.closed) return "refused";
  if (page.sleeping) return "already";
  if (page.visible || page.parked || !page.guestId) return "refused";
  const guestId = page.guestId;
  const reply = await pagesCall<{ entries: (HistoryEntry & { current: boolean })[] }>("page", guestId, "navigationEntries", { withState: true }).catch(() => null);
  const history = asHistory(reply);
  if (page.closed || page.visible || page.parked || page.guestId !== guestId || !history) return "refused";
  page.sleeping = history;
  page.holder = page.element.parentElement;
  page.guestId = 0;
  byGuest.delete(guestId);
  page.attached = readyPromise(page);
  page.element.remove();
  deliver(page, "discarded", { url: currentUrl(history), reason });
  return "discarded";
}

function wake(page: Page, loadInstead: string | null) {
  const history = page.sleeping;
  const holder = page.holder;
  if (!history || !holder?.isConnected) return;
  page.sleeping = null;
  page.holder = null;
  page.started = { url: loadInstead ?? currentUrl(history), at: Date.now() };
  page.element = loadInstead
    ? makeElement(holder.ownerDocument, page, loadInstead, null)
    : makeElement(holder.ownerDocument, page, RESTORES_HISTORY, Promise.resolve(history));
  holder.appendChild(page.element);
  applyVisibility(page);
}

export function discardPage(key: string): Promise<DiscardOutcome> {
  const page = pages.get(key);
  return page ? discard(page, "external") : Promise.resolve("refused");
}

export function parkPage(key: string) {
  const page = pages.get(key);
  if (!page || page.closed) return;
  page.parked = true;
  const guestId = page.guestId;
  page.history = guestId ? pagesCall<{ entries: (HistoryEntry & { current: boolean })[] }>("page", guestId, "navigationEntries", { withState: true }).then(asHistory, () => null) : null;
}

export function releasePage(key: string) {
  const page = pages.get(key);
  if (!page || page.closed) return;
  page.parked = false;
  page.history = null;
  if (!page.sink) close(page);
}

export function pageElement(key: string): HTMLElement | null {
  const page = pages.get(key);
  return page && !page.closed ? page.element : null;
}

export async function focusPage(key: string) {
  const page = pages.get(key);
  if (!page || page.closed) return;
  if (page.sleeping && page.visible) wake(page, null);
  await page.attached;
  if (!page.closed && page.visible) page.element.focus();
}

export async function callPage<Result = unknown>(key: string, method: string, args: Record<string, unknown> = {}): Promise<Result | null> {
  const page = pages.get(key);
  if (!page || page.closed) return null;
  if (method === "loadUrl" && args.url && args.url === page.started.url && Date.now() - page.started.at < SAME_LOAD_MS) return null;
  if (method === "loadUrl") noteLoadAsked(page.opening, args.url);
  if (page.sleeping) {
    if (!WAKING_CALLS.has(method)) return null;
    wake(page, method === "loadUrl" && typeof args.url === "string" ? args.url : null);
    if (method === "reload" || method === "forceReload" || method === "loadUrl") return null;
  }
  const guestId = await page.attached;
  if (!guestId || page.closed) return null;
  return pagesCall<Result>("page", page.guestId || guestId, method, args);
}

export type PageRects = { width: number; height: number; rects: { x: number; y: number; width: number; height: number }[] };

export function pageRectsIn(windowId: string): PageRects | null {
  let view: Window | null = null;
  const rects: PageRects["rects"] = [];
  for (const page of pages.values()) {
    const element = page.element;
    if (!element?.isConnected || windowIdOf(element.ownerDocument) !== windowId) continue;
    view = element.ownerDocument.defaultView;
    if (view?.getComputedStyle(element).visibility === "hidden") continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) rects.push({ x: box.left, y: box.top, width: box.width, height: box.height });
  }
  return view ? { width: view.innerWidth, height: view.innerHeight, rects } : { width: 0, height: 0, rects };
}

(globalThis as { ardiaLinuxPageRects?: typeof pageRectsIn }).ardiaLinuxPageRects = pageRectsIn;
