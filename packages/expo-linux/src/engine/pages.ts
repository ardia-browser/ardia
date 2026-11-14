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
};

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

function fallbackPartition(profile: string) {
  if (profile.includes(PRIVATE_MARK)) return `ardia-private-${encodeURIComponent(profile)}`;
  return profile ? `persist:ardia-${encodeURIComponent(profile)}` : "persist:ardia";
}

const partitionOf = (profile: string) => pagesCallSync<string>("partitionOf", profile) ?? fallbackPartition(profile);

function deliver(page: Page, name: string, data: unknown) {
  if (page.closed) return;
  const shaped = shapedPageEvent(page.opening, name, data);
  page.sink?.(name, shaped);
}

function listen() {
  if (listening) return;
  const bridge = linuxBridge();
  if (!bridge) return;
  listening = true;
  bridge.onEvent((module, event, payload) => {
    if (module === PASSWORDS_MODULE && event === "prompt") return promptToSave(payload);
    if (module !== PAGES_MODULE || event !== "page") return;
    const { guest, name, data } = (payload ?? {}) as { guest?: number; name?: string; data?: unknown };
    const page = typeof guest === "number" ? byGuest.get(guest) : undefined;
    if (page && typeof name === "string" && page.guestId === guest) deliver(page, name, data);
  });
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

function makeElement(page: Page, src: string, history: Promise<History | null> | null): WebviewElement {
  const element = document.createElement("webview") as WebviewElement;
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
  } as unknown as Page;
  page.attached = readyPromise(page);
  page.element = makeElement(page, start.url ?? "", null);
  holder.appendChild(page.element);
  return page;
}

function rebuildIn(page: Page, holder: HTMLElement, start: PageStart) {
  const old = page.element;
  const oldGuest = page.guestId;
  const history = page.history ?? (oldGuest ? pagesCall<{ entries: (HistoryEntry & { current: boolean })[] }>("page", oldGuest, "navigationEntries", { withState: true }).then(asHistory) : Promise.resolve(null));
  page.start = { ...page.start, ...start, url: page.start.url };
  page.started = { url: start.url ?? "", at: Date.now() };
  page.history = null;
  page.guestId = 0;
  const settleWaiting = page.settle;
  page.attached = readyPromise(page);
  void page.attached.then(settleWaiting);
  page.element = makeElement(page, RESTORES_HISTORY, history);
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
  applyVisibility(page);
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
  await page.attached;
  if (!page.closed && page.visible) page.element.focus();
}

export async function callPage<Result = unknown>(key: string, method: string, args: Record<string, unknown> = {}): Promise<Result | null> {
  const page = pages.get(key);
  if (!page || page.closed) return null;
  if (method === "loadUrl" && args.url && args.url === page.started.url && Date.now() - page.started.at < SAME_LOAD_MS) return null;
  if (method === "loadUrl") noteLoadAsked(page.opening, args.url);
  const guestId = await page.attached;
  if (!guestId || page.closed) return null;
  return pagesCall<Result>("page", page.guestId || guestId, method, args);
}
