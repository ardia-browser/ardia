import { hoverHeld } from "../app/transientUi";
import { noteTabHoverCardShown } from "../telemetry/hoverCardCounts";
import { noteLibraryItemCard, noteLibraryItemCardSwap } from "../telemetry/libraryCounts";
import { libraryOpenIn, useLibrary, type LibraryWindow } from "../library/library";
import { consentToken } from "../telemetry/client";
import { noteSidebarHoverHeld, noteSidebarScrolled } from "../telemetry/sidebarScrollCounts";
import { sidebarSliding, useDockMotion } from "../windows/dockMotion";
import { cardReach, pointInRect, type Point, type Rect } from "./hoverAim";
import { measureLibraryAnchor } from "./libraryAnchors";
import { measureRow, setSidebarUi, sidebarUi, type Target } from "./sidebarUi";

export type HoverPointerEvent = { nativeEvent?: { screenX?: unknown; screenY?: unknown } } | undefined;
type Row = { windowId: string; id: string };
type Waiting = { windowId: string; target: Target | null; arrive: () => void };
type Card = { frame: Rect | null; pointerOn: boolean; exit: Point | null; waiting: Waiting | null; held: boolean };

const LIBRARY_CARD_SECTIONS = { media: "media", download: "downloads", visit: "history" } as const;
const isLibraryCard = (kind: string | undefined) => !!kind && kind in LIBRARY_CARD_SECTIONS;
const libraryListsPointed = new Map<string, Set<object>>();
const libraryHeadersPointed = new Map<string, Set<object>>();
const listPointed = (windowId: string) => !!libraryListsPointed.get(windowId)?.size;
const headerPointed = (windowId: string) => !!libraryHeadersPointed.get(windowId)?.size;
const coveredByLibrary = (windowId: string, kind: string) => !isLibraryCard(kind) && libraryOpenIn(windowId);
const libraryChanged = (now: LibraryWindow | undefined, was: LibraryWindow | undefined) =>
  now !== was && (now?.open !== was?.open || now?.section !== was?.section || now?.query !== was?.query || now?.filter !== was?.filter || now?.profile !== was?.profile);
useLibrary.subscribe((s, prev) => {
  const hover = sidebarUi().hover;
  if (!hover || s.windows === prev.windows) return;
  if (coveredByLibrary(hover.windowId, hover.kind)) return dismissHover();
  if (isLibraryCard(hover.kind) && libraryChanged(s.windows[hover.windowId], prev.windows[hover.windowId])) dismissHover();
});
const libraryCardIn = (windowId: string) => {
  const hover = sidebarUi().hover;
  return !!hover && hover.windowId === windowId && isLibraryCard(hover.kind);
};
const DELAY_MS = { show: 800, hide: 160, aim: 200 };
const EXIT_SLOP = 1;
const PEEK_ARRIVAL_MS = 400;
const peekArrivedAt = new Map<string, number>();
useDockMotion.subscribe((m, prev) => {
  if (m.peeks === prev.peeks) return;
  for (const id of Object.keys(m.peeks)) if (!(id in prev.peeks)) peekArrivedAt.set(id, Date.now());
  for (const id of [...peekArrivedAt.keys()]) if (!(id in m.peeks)) peekArrivedAt.delete(id);
});
const sliding = (windowId: string) => sidebarSliding(windowId) || Date.now() - (peekArrivedAt.get(windowId) ?? -Infinity) < PEEK_ARRIVAL_MS;
const timers: Record<keyof typeof DELAY_MS, ReturnType<typeof setTimeout> | undefined> = { show: undefined, hide: undefined, aim: undefined };
const card: Card = { frame: null, pointerOn: false, exit: null, waiting: null, held: false };
const contentHeights = new Map<string, number>();
let owner: Row | null = null;
let underPointer: string | null = null;
let suppressed = false;
let ticket = 0;

const stop = (...kinds: (keyof typeof timers)[]) => kinds.forEach((kind) => clearTimeout(timers[kind]));
const start = (kind: keyof typeof timers, run: () => void) => void (timers[kind] = setTimeout(run, DELAY_MS[kind]));
const isShown = (windowId: string, id: string | undefined) => {
  const hover = sidebarUi().hover;
  return !!hover && hover.windowId === windowId && hover.id === id;
};

export const setHoverSpace = (windowId: string, height: number) => void contentHeights.set(windowId, height);

function pointerIn(windowId: string, event: HoverPointerEvent): Point | null {
  const x = event?.nativeEvent?.screenX;
  const y = event?.nativeEvent?.screenY;
  const height = contentHeights.get(windowId);
  if (typeof x !== "number" || typeof y !== "number" || height === undefined) return null;
  return { x, y: height - y };
}

function hideCard() {
  Object.assign(card, { held: false, pointerOn: false, exit: null, waiting: null });
  stop("aim");
  setSidebarUi({ hover: null });
}

function cardHeldFor(windowId: string, target: Target | null, event: HoverPointerEvent) {
  const hover = sidebarUi().hover;
  if (!hover || hover.windowId !== windowId || !card.frame || (target && hover.id === target.id)) return null;
  const at = pointerIn(windowId, event);
  if (!at) return null;
  const reach = cardReach(card.frame, card.exit, at);
  return reach === "away" ? null : reach;
}

function arrive(next: Waiting | null) {
  if (!next) return hoverLeave();
  next.arrive();
}

function takeWaiting() {
  const next = card.waiting;
  card.waiting = null;
  return next;
}

function holdFor(next: Waiting) {
  card.waiting = next;
  stop("hide", "aim");
  start("aim", () => {
    if (!card.pointerOn) arrive(takeWaiting());
  });
}

const forgetWaiting = (windowId: string, id: string | undefined) => {
  if (card.waiting?.windowId === windowId && card.waiting.target?.id === id) card.waiting = null;
};

export function cardEntered() {
  if (!sidebarUi().hover) return;
  card.pointerOn = true;
  stop("aim");
  keepHover();
}

export function cardLeft() {
  card.pointerOn = false;
  arrive(takeWaiting());
}

export const cardLaidOut = (frame: Rect) => void (card.frame = frame);

export const pointerOnRow = (id: string) => underPointer === id;
export const pointerOnCard = () => card.pointerOn;

const covered = new Set<string>();
const pointedRows = new Map<string, Set<() => void>>();

export function setRowsCovered(windowId: string, on: boolean) {
  if (on === covered.has(windowId)) return;
  if (on) covered.add(windowId);
  else covered.delete(windowId);
  refreshRows(windowId);
}

export const rowsCovered = (windowId: string) => covered.has(windowId) || headerPointed(windowId);

const refreshRows = (windowId: string) => {
  for (const refresh of pointedRows.get(windowId) ?? []) refresh();
};

export type PanelDraw = { open: boolean; newTab: boolean; centred: boolean; hasActiveTab: boolean; sidebarAnchor: boolean };

export const panelCoversRows = (p: PanelDraw) => p.open && p.hasActiveTab && !p.newTab && !p.centred && p.sidebarAnchor;

export function holdRowsCovered(windowId: string, on: boolean) {
  setRowsCovered(windowId, on);
  return () => setRowsCovered(windowId, false);
}

export function watchCovered(windowId: string, refresh: () => void, on: boolean) {
  let rows = pointedRows.get(windowId);
  if (on) {
    if (!rows) pointedRows.set(windowId, (rows = new Set()));
    rows.add(refresh);
  } else if (rows?.delete(refresh) && !rows.size) pointedRows.delete(windowId);
}

export function suppressHover(value: boolean) {
  suppressed = value;
  if (value) dismissHover();
}

async function show(windowId: string, target: Target, mine: number) {
  const consent = consentToken();
  const library = isLibraryCard(target.kind);
  const anchor = await (library ? measureLibraryAnchor : measureRow)(windowId, target.id);
  if (mine !== ticket || suppressed || coveredByLibrary(windowId, target.kind) || !anchor || hoverHeld(windowId) || sliding(windowId)) return;
  if (library && (headerPointed(windowId) || !libraryOpenIn(windowId))) return;
  if (card.pointerOn && sidebarUi().hover) return;
  card.exit = null;
  setSidebarUi({ hover: { windowId, ...target, anchor } });
  if (target.kind === "tab" || target.kind === "folder") noteTabHoverCardShown(consent);
  else if (isLibraryCard(target.kind)) noteLibraryItemCard(LIBRARY_CARD_SECTIONS[target.kind as keyof typeof LIBRARY_CARD_SECTIONS], consent);
}

export function hoverEnter(windowId: string, target: Target) {
  if (coveredByLibrary(windowId, target.kind)) return;
  if (suppressed || hoverHeld(windowId) || sliding(windowId)) return;
  stop("show", "hide", "aim");
  card.waiting = null;
  const current = sidebarUi().hover;
  owner = { windowId, id: target.id };
  if (current?.id === target.id) return;
  if (isLibraryCard(target.kind) && libraryCardIn(windowId)) {
    noteLibraryItemCardSwap();
    return void show(windowId, target, ++ticket);
  }
  if (current && !card.held) hideCard();
  const mine = ++ticket;
  start("show", () => void show(windowId, target, mine));
}

export function hoverLeave(from?: unknown, now = false) {
  if (card.held || (typeof from === "string" && from !== owner?.id)) return;
  if (owner && listPointed(owner.windowId) && libraryCardIn(owner.windowId)) {
    owner = null;
    ticket++;
    return stop("show", "hide");
  }
  owner = null;
  ticket++;
  stop("show", "hide");
  if (now) hideCard();
  else start("hide", hideCard);
}

export const keepHover = () => stop("hide", "aim");

export function holdHover(on: boolean) {
  if (on === card.held) return;
  card.held = on;
  if (on) return keepHover();
  const hover = sidebarUi().hover;
  if (!hover || card.pointerOn) return;
  if (underPointer !== hover.id) return hoverLeave();
  owner = { windowId: hover.windowId, id: hover.id };
}

export function dismissHover() {
  card.held = false;
  owner = null;
  ticket++;
  stop("show", "hide");
  if (sidebarUi().hover) hideCard();
}

export function dismissLibraryCard(windowId: string) {
  if (libraryCardIn(windowId)) dismissHover();
}

export function dismissHoverIn(windowId: string) {
  if (owner?.windowId === windowId || sidebarUi().hover?.windowId === windowId) dismissHover();
}

export function releaseAnchor(windowId: string, id: string) {
  if (underPointer === id) underPointer = null;
  if (libraryRowPointed?.windowId === windowId && libraryRowPointed.target.id === id) libraryRowPointed = null;
  forgetWaiting(windowId, id);
  if (owner?.id === id && owner.windowId === windowId) return dismissHover();
  if (isShown(windowId, id)) hideCard();
}

function setPointed(pointed: Map<string, Set<object>>, windowId: string, by: object, inside: boolean) {
  let lists = pointed.get(windowId);
  if (inside) {
    if (!lists) pointed.set(windowId, (lists = new Set()));
    const added = !lists.has(by);
    lists.add(by);
    return added && lists.size === 1;
  }
  if (!lists?.delete(by)) return false;
  if (lists.size) return false;
  pointed.delete(windowId);
  return true;
}

export function setLibraryListPointed(windowId: string, list: object, inside: boolean) {
  if (!setPointed(libraryListsPointed, windowId, list, inside) || inside) return;
  if (libraryCardIn(windowId) && !card.pointerOn && !owner) start("hide", hideCard);
}

type LibraryEntry = { windowId: string; target: Target; event: HoverPointerEvent; enter: () => void; aiming: () => void };
let libraryRowPointed: LibraryEntry | null = null;

export function setLibraryHeaderPointed(windowId: string, header: object, inside: boolean) {
  if (!setPointed(libraryHeadersPointed, windowId, header, inside)) return;
  refreshRows(windowId);
  if (inside) {
    if (libraryCardIn(windowId) || owner?.windowId === windowId) dismissHover();
    return;
  }
  const entry = libraryRowPointed;
  if (entry?.windowId === windowId) rowEntered(entry.windowId, entry.target, entry.event, entry.enter, entry.aiming);
}

export function rowEntered(windowId: string, target: Target | null, event: HoverPointerEvent, enter: () => void, aiming: () => void) {
  if (target && isLibraryCard(target.kind)) {
    libraryRowPointed = { windowId, target, event, enter, aiming };
    if (headerPointed(windowId)) return;
    if (libraryCardIn(windowId)) return enter();
  }
  const at = pointerIn(windowId, event);
  if (card.pointerOn && at && card.frame && !pointInRect(card.frame, at)) card.pointerOn = false;
  const reach = cardHeldFor(windowId, target, event);
  if (!reach) return enter();
  if (reach === "aiming") aiming();
  holdFor({ windowId, target, arrive: enter });
}

export function rowShown(windowId: string, target: Target | null) {
  underPointer = target?.id ?? null;
  if (target) hoverEnter(windowId, target);
  else hoverLeave(undefined, true);
}

function leftAwayFromCard(): boolean {
  const hover = sidebarUi().hover;
  if (!hover || !card.exit || !card.frame) return false;
  const { x, y, width } = hover.anchor;
  const cardOnRight = card.frame.x >= x + width;
  const behind = cardOnRight ? card.exit.x <= x + EXIT_SLOP : card.exit.x >= x + width - EXIT_SLOP;
  return behind || card.exit.y <= y + EXIT_SLOP;
}

function movedFromUnderPointer(windowId: string, event: HoverPointerEvent) {
  const hover = sidebarUi().hover;
  const at = pointerIn(windowId, event);
  if (!hover || !at || !isLibraryCard(hover.kind)) return false;
  const { x, y, width, height } = hover.anchor;
  return pointInRect({ x: x + EXIT_SLOP, y: y + EXIT_SLOP, width: width - 2 * EXIT_SLOP, height: height - 2 * EXIT_SLOP }, at);
}

export function rowLeft(windowId: string, target: Target | null, event: HoverPointerEvent, onPage: boolean) {
  forgetWaiting(windowId, target?.id);
  if (underPointer === target?.id) underPointer = null;
  if (libraryRowPointed?.windowId === windowId && libraryRowPointed.target.id === target?.id) libraryRowPointed = null;
  const shownHere = !!target && isShown(windowId, target.id);
  if (shownHere) card.exit = pointerIn(windowId, event);
  if (target && onPage) hoverLeave(target.id, shownHere && leftAwayFromCard());
  if (shownHere && !owner && movedFromUnderPointer(windowId, event)) start("hide", hideCard);
}

const SCROLL_SETTLE_MS = 150;
const scrolledAt = new Map<string, number>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heldEnters = new Map<string, Map<object, () => void>>();

function settleWhenStill(windowId: string) {
  const left = (scrolledAt.get(windowId) ?? 0) + SCROLL_SETTLE_MS - Date.now();
  if (left > 0) return void settleTimers.set(windowId, setTimeout(() => settleWhenStill(windowId), left));
  settleTimers.delete(windowId);
  scrolledAt.delete(windowId);
  const held = heldEnters.get(windowId);
  heldEnters.delete(windowId);
  for (const enter of held?.values() ?? []) enter();
}

export function noteRowsScrolled(windowId: string) {
  const now = Date.now();
  noteSidebarScrolled(now);
  scrolledAt.set(windowId, now);
  if (!settleTimers.has(windowId)) settleTimers.set(windowId, setTimeout(() => settleWhenStill(windowId), SCROLL_SETTLE_MS));
}

export const rowsScrolling = (windowId: string) => scrolledAt.has(windowId);

export function holdEnterWhileScrolling(windowId: string, row: object, enter: () => void): boolean {
  if (!scrolledAt.has(windowId)) return false;
  let held = heldEnters.get(windowId);
  if (!held) heldEnters.set(windowId, (held = new Map()));
  if (!held.has(row)) noteSidebarHoverHeld();
  held.set(row, enter);
  return true;
}

export const dropHeldEnter = (windowId: string, row: object) => !!heldEnters.get(windowId)?.delete(row);

const pointedGroups = new Set<string>();

export const pointerOnGroup = (groupId: string) => pointedGroups.has(groupId);

export function setGroupPointed(groupId: string, on: boolean) {
  if (on) pointedGroups.add(groupId);
  else pointedGroups.delete(groupId);
}
