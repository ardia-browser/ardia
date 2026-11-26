import type { PageEngine, ProtectedMediaRequest } from "../../platform/tabs";
import { useBrowser } from "../browser/store";
import { patchPage } from "../tabs/pageState";
import { canSwitchEngine, chosenEngine, chromiumOnly, modeEngineFor, needsChromium, singleEngine, siteOf, tabEngine, webStorePage } from "./engines";
import { navigationOf } from "../tabs/pageSession";
import { declineSite, modeStillHolds, openPageIn, pageUrl, showEngineOffer, siteDeclined, tellChromiumModeBlocks } from "./actions";
import { openedByPage, openerState } from "./openedPages";
import { noteSiteMove } from "../telemetry/engineSwitchCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";

const store = () => useBrowser.getState();
const SITE_MOVE_SPACING_MS = 10_000;

type Move = { from: PageEngine; to: PageEngine; url: string; navigation: number | null; previousUrl: string; consent: ConsentToken | null; forVideo?: { site: string }; delayed?: boolean };
type TabMoves = { lastMovedAt: number; moving: boolean; pending: Move | null; cooling: ReturnType<typeof setTimeout> | null; visit: number };

const tabMoves = new Map<string, TabMoves>();
const probingVideo = new Set<string>();
let unwatch: (() => void) | null = null;

function movesOf(tabId: string): TabMoves {
  unwatch ??= useBrowser.subscribeTo(["tabs"], (s) => {
    for (const [id, moves] of tabMoves) {
      if (s.tabs[id]) continue;
      if (moves.cooling) clearTimeout(moves.cooling);
      tabMoves.delete(id);
    }
  });
  let moves = tabMoves.get(tabId);
  if (!moves) tabMoves.set(tabId, (moves = { lastMovedAt: 0, moving: false, pending: null, cooling: null, visit: 0 }));
  return moves;
}

function queue(moves: TabMoves, move: Move) {
  const kept = moves.pending;
  if (move.forVideo && kept && !kept.forVideo && kept.to === move.to) return;
  moves.pending = { ...move, delayed: true };
}

const declinedVideo = (move: Move) => !!move.forVideo && siteDeclined(move.forVideo.site);

const navigationNow = (tabId: string) => navigationOf(store().tabs[tabId])?.seq ?? null;

function stillFor(tabId: string, move: Move): boolean {
  const t = store().tabs[tabId];
  return !!t && navigationNow(tabId) === move.navigation && siteOf(pageUrl(t)) === siteOf(move.url);
}

function dropMovesLeftBehind(tabId: string) {
  const moves = tabMoves.get(tabId);
  if (moves?.pending && !stillFor(tabId, moves.pending)) moves.pending = null;
}

function dropVideoMovesFor(tabId: string, site: string) {
  const moves = tabMoves.get(tabId);
  if (moves?.pending?.forVideo?.site === site) moves.pending = null;
}

const GOOGLE_SIGN_IN = /^https:\/\/accounts\.google\.com([/?#]|$)/i;
const googleSignIn = (url: string | undefined | null) => !!url && GOOGLE_SIGN_IN.test(url);
const leftForChromium = (url: string | undefined | null) => webStorePage(url) || googleSignIn(url);

const reachable = (url: string, engine: PageEngine) => canSwitchEngine(url) || (engine === "chromium" && webStorePage(url));

function siteEngine(tabId: string, url: string): PageEngine | undefined {
  const s = store();
  const t = s.tabs[tabId];
  if (!t) return undefined;
  return singleEngine(s) ? modeEngineFor(s, t, url) : chosenEngine(s, url);
}

export const routedTo = (tabId: string, engine: PageEngine) => (url: string) => siteEngine(tabId, url) === engine && reachable(url, engine);

function startMove(tabId: string, move: Move) {
  const moves = movesOf(tabId);
  if (declinedVideo(move)) return;
  if (moves.moving || moves.cooling) return queue(moves, move);
  const wait = SITE_MOVE_SPACING_MS - (Date.now() - moves.lastMovedAt);
  if (!move.forVideo && wait > 0) {
    queue(moves, move);
    moves.cooling = setTimeout(() => {
      moves.cooling = null;
      drain(tabId, moves);
    }, wait);
    return;
  }
  moves.moving = true;
  void runMove(tabId, moves, move);
}

async function runMove(tabId: string, moves: TabMoves, move: Move) {
  const holds = modeStillHolds();
  const opened = openedByPage(tabId);
  const video = move.forVideo;
  const options = video
    ? {
        routedHere: routedTo(tabId, move.to),
        onStayed: () => {
          declineSite(video.site);
          dropVideoMovesFor(tabId, video.site);
        },
      }
    : { checkWork: !!move.delayed, routedHere: routedTo(tabId, move.to) };
  let moved = false;
  try {
    moved = await openPageIn(tabId, move.to, options);
  } catch {
    moved = false;
  } finally {
    moves.moving = false;
  }
  if (!video && (moved || !moves.pending)) noteSiteMove(moved ? "moved" : "dropped", opened, move.consent);
  if (moved) {
    moves.lastMovedAt = Date.now();
    if (holds() && (canSwitchEngine(move.previousUrl) || needsChromium(move.previousUrl))) patchPage(tabId, { engineBack: { engine: move.from, url: move.previousUrl } });
  }
  drain(tabId, moves);
}

function drain(tabId: string, moves: TabMoves) {
  const next = moves.pending;
  moves.pending = null;
  if (next && tabMoves.get(tabId) === moves) settlePending(tabId, next);
}

function settlePending(tabId: string, move: Move) {
  const t = store().tabs[tabId];
  if (!t) return;
  const url = pageUrl(t);
  const from = tabEngine(store(), tabId);
  if (from === move.to || !stillFor(tabId, move) || declinedVideo(move) || !routedTo(tabId, move.to)(url)) return;
  startMove(tabId, { ...move, from });
}

async function moveOpenedTab(tabId: string, url: string, move: Move) {
  const holds = modeStillHolds();
  const visit = movesOf(tabId).visit;
  const sameVisit = () => tabMoves.get(tabId)?.visit === visit && navigationNow(tabId) === move.navigation;
  const stillOnSite = () => !!store().tabs[tabId] && holds() && sameVisit() && siteOf(pageUrl(store().tabs[tabId])) === siteOf(url) && tabEngine(store(), tabId) === move.from;
  const opener = await openerState(tabId, stillOnSite);
  if (!stillOnSite() || !routedTo(tabId, move.to)(pageUrl(store().tabs[tabId]))) return;
  if (opener === "live") return noteSiteMove("keptForOpener", true, move.consent);
  if (opener === "unknown") return noteSiteMove("dropped", true, move.consent);
  startMove(tabId, { ...move, delayed: true });
}

export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const s = store();
  const t = s.tabs[tabId];
  if (!t) return;
  const consent = consentToken();
  dropMovesLeftBehind(tabId);
  if (siteOf(url) !== siteOf(previousUrl)) movesOf(tabId).visit++;
  const navigation = navigationNow(tabId);
  if (singleEngine(s)) {
    const forced = modeEngineFor(s, t, url);
    const followsMode = forced === "chromium" || chromiumOnly(previousUrl) || (leftForChromium(previousUrl) && !googleSignIn(url));
    if (forced && forced !== engine && followsMode && (canSwitchEngine(url) || needsChromium(url))) startMove(tabId, { from: engine, to: forced, url, navigation, previousUrl, consent });
    return;
  }
  const site = siteOf(url);
  if (!site || site === siteOf(previousUrl)) return;
  const chosen = chosenEngine(s, url);
  if (!chosen || chosen === engine) return;
  const move = { from: engine, to: chosen, url, navigation, previousUrl, consent };
  if (openedByPage(tabId)) return void moveOpenedTab(tabId, url, move);
  startMove(tabId, move);
}

async function moveForProtectedVideo(tabId: string, site: string, keySystem: string) {
  if (probingVideo.has(tabId)) return;
  const holds = modeStillHolds();
  const consent = consentToken();
  const onSite = () => holds() && siteOf(pageUrl(store().tabs[tabId])) === site && tabEngine(store(), tabId) !== "webkit";
  const stillRouted = () => onSite() && routedTo(tabId, "webkit")(pageUrl(store().tabs[tabId]));
  let opener: "live" | "none" | "unknown" = "none";
  if (openedByPage(tabId)) {
    probingVideo.add(tabId);
    try {
      opener = await openerState(tabId, onSite);
    } finally {
      probingVideo.delete(tabId);
    }
  }
  if (!stillRouted()) return;
  if (opener !== "none") {
    noteSiteMove(opener === "live" ? "keptForOpener" : "dropped", true, consent);
    return showEngineOffer(tabId, site, keySystem);
  }
  startMove(tabId, { from: tabEngine(store(), tabId), to: "webkit", url: pageUrl(store().tabs[tabId]), navigation: navigationNow(tabId), previousUrl: "", consent, forVideo: { site } });
}

export function offerWebKit(tabId: string, { keySystem }: ProtectedMediaRequest) {
  const s = store();
  const t = s.tabs[tabId];
  if (!t || tabEngine(s, tabId) === "webkit") return;
  const site = siteOf(t.url);
  if (!site) return;
  if (singleEngine(s) === "chromium") return tellChromiumModeBlocks(t, site);
  if (singleEngine(s)) return;
  const rule = chosenEngine(s, t.url);
  if (rule === "chromium" || siteDeclined(site)) return;
  if (rule === "webkit") return void moveForProtectedVideo(tabId, site, keySystem);
  if (!canSwitchEngine(t.url)) return;
  showEngineOffer(tabId, site, keySystem);
}
