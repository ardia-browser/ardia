import { fieldFocusedIn } from "../appKeyboard";
import { discardOffered, hostCall, onEngineTopic } from "./host";
import { asOpenWindowRequest, listeningBrowserPages, offeredTabAdopting, openInBrowserWindow, requestHost, type RequestPage } from "./requestHosts";
import { noteLoadAsked, openingPage, shapedPageEvent, type OpeningPage } from "./pageEvents";
import { privateSessionOpened } from "./privateWindows";
import type { ExternalAppRequest, NavigationState, OpenWindowRequest } from "@ardia/ardiacore";
import type { CoverRect } from "./covers";
import type { ExternalApps } from "./domains/externalApps";
import { notePageAsked, notePageSettled } from "./dialogPages";
import { noteShowStep } from "./showTrace";
import { popupFeatures } from "./popupPlacement";
import { isPopupWindowId, onPopupWindowClosed, openPopupWindow, popupOpenerKey, type PopupWindowInfo } from "./popupWindows";
import { dropKeptFollow, keepFollow, spendKeptFollow } from "./keptFollow";
import { handPopupAsTab } from "./popupsAsTabs";

export type PageListener = (name: string, data: unknown) => void;
export type PageRect = Omit<CoverRect, "radius">;
export type PageShape = PageRect & { radius: number; holes: number[][] };
export type PageStart = { url?: string; profile?: string; adopt?: string; contentsBackground?: string; windowId: string };

type ShowArgs = { key: string; visible: boolean; contentsBackground?: string } & Partial<PageShape>;

export type Page = {
  key: string;
  windowId: string;
  from: PageStart;
  profile: string;
  started: { url: string; at: number };
  opening: OpeningPage;
  ready: Promise<boolean>;
  listeners: Set<PageListener>;
  told: Set<PageListener>;
  show: ShowArgs | null;
  showSent: ShowArgs | null;
  mounts: number;
  parked: boolean;
  closed: boolean;
  focusAsked: number;
  focusArgs: Record<string, unknown>;
};

type OpenedTab = { adopt?: unknown; url?: unknown; foreground?: unknown; window?: unknown; opener?: unknown; profile?: unknown; fromClick?: unknown; point?: unknown; popup?: unknown };
type OpenedRequest = OpenWindowRequest & { adoptId: string };
type Point = NonNullable<OpenWindowRequest["point"]>;
type TabEvent = { key?: unknown; name?: unknown; data?: unknown };

const SAME_LOAD_MS = 2000;
const FOCUS_WAITS_FOR_SHOW_MS = 1500;

const pages = new Map<string, Page>();
const closings = new Map<string, Promise<void>>();
const pressListeners = new Set<(windowId: string) => void>();
let listening = false;
let lastAskedToFocus: Page | null = null;
type ExternalAppAnswers = Pick<ExternalApps, "forget" | "forgetPage"> & { ask: (profile: string, page: string, data: unknown) => Promise<ExternalAppRequest | null> };

let externalAppAnswers: ExternalAppAnswers | null = null;

export function answerExternalAppsWith(answers: ExternalAppAnswers) {
  externalAppAnswers = answers;
}

export function externalAppDropped(key: string, id: string) {
  const page = pages.get(key);
  if (!page) return;
  quietly(page.ready.then((opened) => (opened ? hostCall("tab.call", { key, method: "externalAppForget", id }) : null)));
}

export function externalAppStillAsked(key: string, id: string): Promise<boolean> {
  return callPage<{ alive?: unknown }>(key, "externalAppAlive", { id }).then((answer) => answer?.alive === true);
}

function askExternalApp(page: Page, data: unknown) {
  const answers = externalAppAnswers;
  if (!answers) return;
  quietly(
    answers.ask(page.profile, page.key, data).then((request) => {
      if (!request) return;
      if (page.closed) return answers.forget(request.id);
      const host = isPopupWindowId(page.windowId) ? requestHost(pages.get(popupOpenerKey(page.windowId)), page.profile, pages.values()) : page;
      if (!host) return answers.forget(request.id);
      for (const listener of [...host.listeners]) listener("externalApp", request);
    }),
  );
}

const sendTo = (name: string, data: unknown) => (host: RequestPage) => [...host.listeners].forEach((listener) => listener(name, data));

function handOpenedTab(asking: Page | undefined, opener: Page | undefined, request: OpenedRequest) {
  const host = requestHost(opener, request.profile ?? asking?.profile, pages.values());
  if (host) return sendTo("openWindow", request)(host);
  const discard = () => quietly(hostCall("tab.discard", { adopt: request.adoptId }));
  if (asking && isPopupWindowId(asking.windowId)) return openInBrowserWindow(request, request.profile ?? asking.profile, asking.windowId, discard);
  if (listeningBrowserPages(pages.values()).length) console.warn("[ardia windows] a tab opened by a page was closed: no page of its profile is showing");
  discard();
}

function openFromPopup(page: Page, request: unknown) {
  const asked = asOpenWindowRequest(request);
  if (!asked) return;
  const moved = { ...asked, point: undefined };
  const host = requestHost(pages.get(popupOpenerKey(page.windowId)), page.profile, pages.values());
  if (host) return sendTo("openWindow", moved)(host);
  openInBrowserWindow(moved, page.profile, page.windowId, () => console.warn("[ardia windows] a link from a private pop-up was dropped: no window of its private session can take it"));
}

function popupWindowGone(popup: PopupWindowInfo) {
  const page = pages.get(popup.pageKey);
  if (page && !page.closed) return closePage(page);
  if (!page) quietly(discardOffered(popup.adopt));
}

export function onPagePress(listener: (windowId: string) => void): () => void {
  pressListeners.add(listener);
  listen();
  return () => void pressListeners.delete(listener);
}

const quietly = (work: Promise<unknown>) => void work.catch(() => {});

const isPoint = (value: unknown): value is Point =>
  typeof value === "object" && value !== null && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

function inWindow(page: Page | undefined, point: unknown): Point | undefined {
  const shown = page?.show;
  if (!shown?.visible || typeof shown.x !== "number" || typeof shown.y !== "number" || !isPoint(point)) return undefined;
  return { x: shown.x + point.x, y: shown.y + point.y };
}

function placedPoint(page: Page, name: string, data: unknown): unknown {
  if (name !== "openWindow" || typeof data !== "object" || data === null || !("point" in data)) return data;
  return { ...data, point: inWindow(page, (data as { point?: unknown }).point) };
}

function listen() {
  if (listening) return;
  listening = true;
  onEngineTopic("tab", (event: TabEvent) => {
    if (typeof event.key !== "string" || typeof event.name !== "string") return;
    const page = pages.get(event.key);
    if (!page) return;
    if (event.name === "pagePress") {
      dropKeptFollow();
      lastAskedToFocus = page;
      page.focusAsked = 0;
      for (const pressed of [...pressListeners]) pressed(page.windowId);
    }
    if (event.name === "externalApp") return askExternalApp(page, event.data);
    if (event.name === "navigation" && (event.data as Partial<Pick<NavigationState, "isLoading">> | null)?.isLoading === false) notePageSettled(page.key);
    if (event.name === "openWindow" && isPopupWindowId(page.windowId)) return openFromPopup(page, shapedPageEvent(page.opening, event.name, event.data));
    const data = placedPoint(page, event.name, shapedPageEvent(page.opening, event.name, event.data));
    for (const listener of [...page.listeners]) listener(event.name, data);
  });
  onPopupWindowClosed(popupWindowGone);
  onEngineTopic("tab.opened", (opened: OpenedTab) => {
    if (typeof opened.adopt !== "string") return;
    const asking = typeof opened.opener === "string" ? pages.get(opened.opener) : undefined;
    const opener = asking && isPopupWindowId(asking.windowId) ? pages.get(popupOpenerKey(asking.windowId)) : asking;
    const fromClick = opened.fromClick === true;
    const request: OpenedRequest = {
      url: typeof opened.url === "string" ? opened.url : "",
      disposition: opened.window === true ? "window" : opened.foreground === true ? "foreground" : "background",
      adoptId: opened.adopt,
      userGesture: true,
      profile: typeof opened.profile === "string" ? opened.profile : undefined,
      fromClick,
      point: fromClick && asking === opener ? inWindow(opener, opened.point) : undefined,
    };
    const features = popupFeatures(opened.popup);
    if (!features) return handOpenedTab(asking, opener, request);
    const openedFrom = opener && !opener.closed ? opener : undefined;
    if (handPopupAsTab(openedFrom, request, pages.values())) return;
    const ask = { adopt: request.adoptId, url: request.url, profile: request.profile ?? openedFrom?.profile ?? "", openerKey: openedFrom?.key ?? "", openedFromKey: (asking && !asking.closed ? asking : openedFrom)?.key ?? "", openedFromWindowId: (asking && !asking.closed ? asking : openedFrom)?.windowId ?? "", features };
    quietly(
      openPopupWindow(ask).then((outcome) => {
        if (outcome === "failed") handOpenedTab(asking, opener, { ...request, disposition: "foreground" });
      }),
    );
  });
}

const offeredByEngine = (adopt: string | undefined) => (adopt?.startsWith("ardiacore:") ? adopt : "");

function start(key: string, from: PageStart): Promise<boolean> {
  const url = from.url ?? "";
  const create = (adopt: string) => hostCall("tab.create", { key, url, profile: from.profile ?? "", adopt, ...(from.contentsBackground ? { contentsBackground: from.contentsBackground } : {}) }, from.windowId);
  const offered = offeredByEngine(from.adopt);
  const closing = closings.get(key);
  return (closing ? closing.then(() => create(offered)) : create(offered))
    .catch((error: unknown) => {
      if (!offered || !url) throw error;
      return create("");
    })
    .then(
      () => {
        privateSessionOpened(from.profile ?? "");
        return true;
      },
      (error: unknown) => {
        console.warn(`[ardia windows] the page for ${key} did not open: ${String((error as Error)?.message ?? error)}`);
        return false;
      },
    );
}

function begin(page: Page, from: PageStart): Promise<boolean> {
  page.told.clear();
  page.showSent = null;
  return start(page.key, from);
}

function tellReady(page: Page, listener: PageListener) {
  if (page.closed || !page.listeners.has(listener) || page.told.has(listener)) return;
  page.told.add(listener);
  listener("ready", {});
}

function sendShow(page: Page): Promise<unknown> | undefined {
  const args = page.show;
  if (!args || args === page.showSent || page.closed) return void noteShowStep(page.key, `sendShow: ${!args ? "nothing" : page.closed ? "closed" : "already sent"}`);
  page.showSent = args;
  noteShowStep(page.key, `sendShow: ${args.visible ? "shown" : "hidden"}`);
  return hostCall("tab.show", args, page.windowId).catch((error: unknown) => {
    throw (console.warn(`[ardia windows] the page ${page.key} could not show: ${String((error as Error)?.message ?? error)}`), error);
  });
}

function followNow(page: Page) {
  lastAskedToFocus = page;
  page.focusArgs = { follow: true };
}

const focusWaits = (page: Page) => lastAskedToFocus === page && page.focusAsked > 0 && Date.now() - page.focusAsked < FOCUS_WAITS_FOR_SHOW_MS;

function askShow(page: Page, args: ShowArgs) {
  page.show = args;
  quietly(
    page.ready.then((opened) => {
      if (!opened || page.show !== args) return noteShowStep(page.key, opened ? "askShow: superseded" : "askShow: not opened");
      const sent = sendShow(page);
      const kept = args.visible && spendKeptFollow(page.key, page.windowId);
      if (kept) followNow(page);
      if (!args.visible || !(kept || focusWaits(page))) return sent;
      page.focusAsked = 0;
      const focusArgs = page.focusArgs;
      if (fieldFocusedIn(page.windowId, page.key)) return sent;
      return Promise.resolve(sent).then(() =>
        page.closed || lastAskedToFocus !== page || fieldFocusedIn(page.windowId, page.key) ? undefined : hostCall("tab.call", { ...focusArgs, key: page.key, method: "focus", deferred: true }),
      );
    }),
  );
}

export function mountPage(key: string, from: PageStart, listener: PageListener): () => void {
  listen();
  let page = pages.get(key);
  if (!page || page.closed) {
    page = {
      key,
      windowId: from.windowId,
      from,
      profile: from.profile ?? "",
      started: { url: from.url ?? "", at: Date.now() },
      opening: openingPage(from.url ?? "", !!offeredByEngine(from.adopt)),
      ready: Promise.resolve(false),
      listeners: new Set(),
      told: new Set(),
      show: null,
      showSent: null,
      mounts: 0,
      parked: false,
      closed: false,
      focusAsked: 0,
      focusArgs: {},
    };
    notePageAsked(key);
    page.ready = begin(page, from);
    pages.set(key, page);
  } else if (page.windowId !== from.windowId) {
    noteShowStep(key, `mount: window ${page.windowId} to ${from.windowId}`);
    page.windowId = from.windowId;
    page.from = from;
    page.profile = from.profile ?? "";
    page.show = null;
    const moving = page;
    page.ready = page.ready.then((opened) => (moving.closed ? opened : begin(moving, from)));
  }
  const mounted = page;
  mounted.parked = false;
  mounted.mounts += 1;
  mounted.listeners.add(listener);
  const adopting = offeredTabAdopting(from.adopt);
  void mounted.ready.then((opened) => {
    adopting(opened);
    if (opened) tellReady(mounted, listener);
  });
  return () => {
    mounted.listeners.delete(listener);
    mounted.mounts -= 1;
    if (mounted.mounts > 0) return;
    if (mounted.parked) {
      askShow(mounted, { key, visible: false });
      return;
    }
    closePage(mounted);
  };
}

function closePage(page: Page) {
  if (page.closed) return;
  page.closed = true;
  if (lastAskedToFocus === page) lastAskedToFocus = null;
  externalAppAnswers?.forgetPage(page.key);
  notePageSettled(page.key);
  if (pages.get(page.key) === page) pages.delete(page.key);
  const closing: Promise<void> = page.ready
    .then(() => hostCall("tab.close", { key: page.key }))
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      if (closings.get(page.key) === closing) closings.delete(page.key);
    });
  closings.set(page.key, closing);
}

export function showPage(key: string, visible: boolean, shape: PageShape | null, askedIn?: string, contentsBackground?: string): boolean {
  const page = pages.get(key);
  if (!page || page.closed) return (noteShowStep(key, page ? "showPage: closed" : "showPage: no page"), false);
  if (askedIn !== undefined && askedIn !== page.windowId) return (noteShowStep(key, `showPage: asked in ${askedIn}, the page is in ${page.windowId}`), false);
  if (contentsBackground) page.from = { ...page.from, contentsBackground };
  return (askShow(page, visible && shape ? { key, visible: true, ...shape, ...(contentsBackground ? { contentsBackground } : {}) } : { key, visible: false }), true);
}

const REOPENING_METHODS = new Set(["loadUrl", "reload", "reloadToPlay", "forceReload"]);

function readyOrReopened(page: Page, url: unknown): Promise<boolean> {
  page.ready = page.ready.then((opened) => {
    if (opened || page.closed) return opened;
    notePageAsked(page.key);
    return begin(page, { ...page.from, adopt: undefined, windowId: page.windowId }).then((again) => {
      if (page.closed) return again;
      if (again) {
        quietly(sendShow(page) ?? Promise.resolve());
        for (const listener of [...page.listeners]) tellReady(page, listener);
      } else for (const listener of [...page.listeners]) listener("loadError", { url: typeof url === "string" ? url : page.from.url ?? "", code: 0, text: "the page could not open" });
      return again;
    });
  });
  return page.ready;
}

export function callPage<Result = unknown>(key: string, method: string, args: Record<string, unknown> = {}): Promise<Result | null> {
  const page = pages.get(key);
  if (!page || page.closed) return Promise.resolve(null);
  if (method === "loadUrl" && args.url === page.started.url && Date.now() - page.started.at < SAME_LOAD_MS) return Promise.resolve(null);
  if (method === "loadUrl") noteLoadAsked(page.opening, args.url);
  if (method === "focus") {
    dropKeptFollow();
    lastAskedToFocus = page;
    page.focusArgs = args;
    page.focusAsked = page.show?.visible ? 0 : Date.now();
    if (page.focusAsked) return Promise.resolve(null);
    if (args.follow === true && fieldFocusedIn(page.windowId, page.key)) return Promise.resolve(null);
  }
  const ready = REOPENING_METHODS.has(method) ? readyOrReopened(page, args.url) : page.ready;
  return ready.then((opened) => (opened && !page.closed ? hostCall<Result>("tab.call", { key, method, ...args }) : null));
}

export function followPage(key: string, windowId = "") {
  const page = pages.get(key);
  if (page && !page.closed && page.show?.visible && page.show === page.showSent && (!windowId || page.windowId === windowId)) return void callPage(key, "focus", { follow: true });
  keepFollow(key);
  lastAskedToFocus = null;
}

export function parkPage(key: string) {
  const page = pages.get(key);
  if (page) page.parked = true;
}

export function releasePage(key: string) {
  const page = pages.get(key);
  if (!page) return;
  page.parked = false;
  if (page.mounts <= 0) closePage(page);
}

export async function pageGone(key: string, waits = 25): Promise<void> {
  for (let left = waits; left > 0 && pages.has(key); left--) await new Promise((done) => setTimeout(done, 16));
  await closings.get(key);
}

export function pageOpened(key: string): Promise<boolean> {
  const page = pages.get(key);
  return page && !page.closed ? page.ready : Promise.resolve(false);
}
