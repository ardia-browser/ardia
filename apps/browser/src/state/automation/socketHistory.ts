import { engineProfile } from "../browser/model";
import { pruneEngineFavicons, cacheKey } from "../favicons/favicons";
import { clearBrowsingData } from "../profiles/profileData";
import { queryHistory } from "../../platform/history";
import { isWebPageUrl } from "../../lib/url";
import { historyHandle, historyPageOf, type HistoryPage } from "./historyHandles";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { ids, int, obj, PAGE, PROFILE, text } from "./socketSchema";
import { now, page, profileArg } from "./socketTargets";
import { CLIPPED_STRING_CHARS } from "./socketWire";
import { OpError } from "./workspaceTargets";

export const HISTORY_SCAN = 20_000;
const MAX_RAW_HISTORY_ROWS = 200_000;

type Visited = { url: string; title: string; visits: number; lastVisit: number };
type Read = { rows: Visited[]; scanLimited: boolean; webTotal: number | null };

const visitedOf = (e: { url: string; title: string; visits: number; visitTimes: number[] }): Visited => ({ url: e.url, title: e.title, visits: e.visits, lastVisit: e.visitTimes[0] ?? 0 });

async function engineWebPages(engine: string, count: number): Promise<Read> {
  const first = await queryHistory(engine, count, 1);
  const pages = first.filter((e) => isWebPageUrl(e.url));
  if (first.length < count) return { rows: pages.map(visitedOf), scanLimited: false, webTotal: pages.length };
  if (pages.length >= count) return { rows: pages.slice(0, count).map(visitedOf), scanLimited: false, webTotal: null };
  const whole = await queryHistory(engine, MAX_RAW_HISTORY_ROWS + 1, 1);
  const within = whole.slice(0, MAX_RAW_HISTORY_ROWS).filter((e) => isWebPageUrl(e.url));
  const ended = whole.length <= MAX_RAW_HISTORY_ROWS;
  return { rows: within.slice(0, count).map(visitedOf), scanLimited: !ended && within.length < count, webTotal: ended ? within.length : null };
}

async function newestPages(engine: string, count: number): Promise<Read> {
  const view = now().history[engine];
  if (view?.ready && (view.list.length >= count || view.floor === -Infinity)) {
    const rows = [...view.list].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, count);
    const webTotal = view.floor === -Infinity ? view.list.length : null;
    return { rows: rows.map((h) => ({ url: h.url, title: h.title, visits: h.visits, lastVisit: h.lastVisit })), scanLimited: false, webTotal };
  }
  return engineWebPages(engine, count);
}

async function historySearch(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const q = ((params.query as string | undefined) ?? "").toLowerCase();
  const since = (params.since as number | undefined) ?? -Infinity;
  const until = (params.until as number | undefined) ?? Infinity;
  const filtered = !!q || params.since !== undefined || params.until !== undefined;
  const offset = (params.offset as number | undefined) ?? 0;
  const limit = (params.limit as number | undefined) ?? 100;
  const read = filtered ? HISTORY_SCAN + 1 : Math.min(offset + limit + 1, HISTORY_SCAN + 1);
  const { rows, scanLimited, webTotal } = await newestPages(engine, read);
  const scanned = rows.slice(0, HISTORY_SCAN);
  const hits = filtered ? scanned.filter((h) => h.lastVisit >= since && h.lastVisit <= until && (!q || h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q))) : scanned;
  const shown = page(hits, params, (h) => ({ id: historyHandle(call, { url: h.url, profileId, engine }), ...h }));
  const reason = scanLimited ? "scanLimit" : rows.length > HISTORY_SCAN || (webTotal ?? 0) > HISTORY_SCAN ? "window" : null;
  const complete = webTotal !== null && webTotal <= HISTORY_SCAN;
  return { items: shown.items, total: complete ? (filtered ? hits.length : webTotal) : null, nextOffset: shown.nextOffset, truncated: !!reason, ...(reason ? { reason } : {}) };
}

function pagesForIds(given: string[], connection: number, profile: unknown): HistoryPage[] {
  const named = profile === undefined ? null : profileArg(profile);
  return given.map((id) => {
    const found = historyPageOf(connection, id);
    if (!found) throw new OpError("bad_request", `${id}: unknown history id; search again.`);
    if (named !== null && found.profileId !== named) throw new OpError("bad_request", `${id} is from profile ${found.profileId}'s history, not ${named}'s.`);
    return found;
  });
}

async function engineDeleted(deleting: Promise<unknown>) {
  try {
    await deleting;
  } catch (error) {
    throw new OpError("failed", `Ardia hid those pages, but the history database didn't delete them, so they may come back after a restart: ${String((error as Error)?.message ?? error)}`);
  }
}

async function historyRemove(params: Record<string, unknown>, call: SocketCall) {
  const given = params.ids as string[] | undefined;
  const urls = params.urls as string[] | undefined;
  if (!given === !urls) throw new OpError("bad_request", "history.remove takes ids (from history.search) or urls, one of the two.");
  if (urls) {
    if (urls.some((url) => url.length >= CLIPPED_STRING_CHARS)) {
      throw new OpError("bad_request", `A URL of ${CLIPPED_STRING_CHARS} characters or more may be one history.search cut short, so it can't name a page; pass that row's id instead.`);
    }
    await engineDeleted(now().removeHistory(profileArg(params.profile), urls));
    return { ok: true };
  }
  const byProfile = new Map<string, { engine: string; urls: string[] }>();
  for (const found of pagesForIds(given!, call.connection, params.profile)) {
    const entry = byProfile.get(found.profileId) ?? { engine: found.engine, urls: [] };
    if (entry.engine !== found.engine) throw new OpError("bad_request", "Those ids were read from different histories of one profile; search again.");
    entry.urls.push(found.url);
    byProfile.set(found.profileId, entry);
  }
  for (const [profileId, entry] of byProfile) {
    if (!now().profiles[profileId] || engineProfile(now(), profileId) !== entry.engine) throw new OpError("bad_request", `Profile ${profileId}'s history moved since that search; search again.`);
  }
  await engineDeleted(Promise.all([...byProfile].map(([profileId, entry]) => now().removeHistory(profileId, entry.urls))));
  return { ok: true };
}

async function historyClear(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const startedAt = Date.now();
  const since = params.since as number | undefined;
  await clearBrowsingData(engine, ["history"], since);
  if (call.serving() && engineProfile(now(), profileId) === engine) now().clearHistory(profileId, since, startedAt);
  pruneEngineFavicons(cacheKey(profileId));
  return { ok: true };
}

const SINCE = int("Milliseconds since 1970", 0);

export const HISTORY_METHODS: MethodSpec[] = [
  {
    name: "history.search",
    mutates: false,
    description: "Visited pages whose title or URL contains the query, newest first; ids are handles for this connection",
    params: obj({ profile: PROFILE, query: text("Text to look for"), since: SINCE, until: SINCE, ...PAGE }),
    result: "{items: [{id, url, title, visits, lastVisit, clipped?}], total, nextOffset, truncated, reason?: window | scanLimit}",
    run: historySearch,
  },
  {
    name: "history.remove",
    mutates: true,
    description: "Remove pages from history: every visit to each exact URL, as the browser's own Remove from History does",
    params: obj({ profile: PROFILE, ids: ids("Ids from history.search on this connection", 1000), urls: ids("Exact URLs, none of them clipped (shorter than 32,768 characters)", 1000) }),
    result: "{ok}",
    run: historyRemove,
  },
  { name: "history.clear", mutates: true, description: "Clear a profile's history, all of it or since a time, as Clear Browsing Data does", params: obj({ profile: PROFILE, since: SINCE }), result: "{ok}", run: historyClear },
];
