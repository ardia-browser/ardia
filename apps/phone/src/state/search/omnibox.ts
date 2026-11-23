import {
  mobileDisplay,
  mobileEngines,
  mobileParseRemote,
  mobileResolve,
  mobileSetSearch,
  mobileSetSources,
  mobileSuggest,
  mobileSuggestRequest,
  sameAddress,
  spacedAddressGuess,
} from "@ardia/core/src/mobile.ts";
import { dedupeByLanding, displayHost, landingKey } from "../../lib/url.ts";
import type { PasteOffer } from "./pasteRow.ts";

export type TrayRow =
  | { key: string; kind: "query"; title: string; url: string; query: string; detail?: string | null }
  | { key: string; kind: "page"; title: string; detail: string; url: string; favicon: string | null; tabId: string | null; switchesTab: boolean; fromMac?: string | null }
  | { key: string; kind: "calc"; title: string; detail: string; url: string; value: string }
  | { key: string; kind: "paste"; title: string; detail: string; url: string; offer: PasteOffer }
  | { key: string; kind: "browseForMe"; title: string; detail: string; url: string; query: string };

export type { PasteOffer };


export const SWITCH_TO_TAB = "Switch to Tab";

export const BROWSE_FOR_ME = "Browse for Me";

const BROWSE_FOR_ME_SHORTEST = 3;

export const IDLE_ROW_LIMIT = 5;

export const ROW_LIMIT = 9;

export type Suggested = { rows: TrayRow[]; completion: string };

export type SuggestContext = { currentUrl: string | null; currentTabId: string | null };

export type OmniboxSources = Parameters<typeof mobileSetSources>[0];

export function suggest(text: string, remote: readonly string[], context: SuggestContext, macTabs: ReadonlyMap<string, string> = new Map(), browsesForMe = false): Suggested {
  if (!text.trim()) return { rows: [], completion: "" };
  const result = mobileSuggest(text, { remote: [...remote], preference: "website", limit: ROW_LIMIT, now: Date.now(), ...context });
  const rows: TrayRow[] = [];
  const guess = spacedAddressGuess(text);
  for (const item of result.items) {
    const typedAddress = item.kind === "search" ? mobileResolve(item.query) : null;
    if (item.kind === "search" && typedAddress?.kind === "url") rows.push(addressRow(typedAddress.url));
    else if (item.kind === "search") rows.push({ key: `q:${item.query}`, kind: "query", title: item.query, url: item.url, query: item.query, detail: item.bang ? `Search ${item.engine}` : null });
    else if (item.kind === "page") {
      const shown = mobileDisplay(item.url, item.title);
      const host = displayHost(shown.host, item.url);
      const mac = item.tabId ? null : (macTabs.get(landingKey(item.url)) ?? null);
      rows.push({
        key: `p:${item.tabId ?? ""}:${item.url}`,
        kind: "page",
        title: item.title || host,
        detail: item.tabId ? SWITCH_TO_TAB : !item.title && guess && sameAddress(item.url, guess) ? shown.display : host,
        url: item.url,
        favicon: item.favicon ?? null,
        tabId: item.tabId ?? null,
        switchesTab: Boolean(item.tabId),
        fromMac: mac,
      });
    } else if (item.kind === "calc") rows.push({ key: `c:${item.expression}`, kind: "calc", title: `= ${item.value}`, detail: item.expression, url: item.url, value: item.value });
  }
  const landing = (row: TrayRow) => (row.kind !== "page" ? row.key : guess && sameAddress(row.url, guess) ? `guess:${guess}` : row.url);
  const unique = dedupeByLanding(rows.map((row) => ({ row, url: landing(row), opensTab: row.kind === "page" && row.switchesTab })));
  const typed = withTypedQuery(unique.map((item) => item.row), text);
  return { rows: browsesForMe ? withBrowseForMe(typed, text) : typed, completion: result.completion };
}

export function offersBrowseForMe(text: string): boolean {
  const typed = text.trim();
  if (typed.length < BROWSE_FOR_ME_SHORTEST || typed.startsWith("!") || typed.includes(" !")) return false;
  return mobileResolve(typed)?.kind === "search";
}

export function withBrowseForMe(rows: TrayRow[], text: string): TrayRow[] {
  const typed = text.trim();
  if (!offersBrowseForMe(typed)) return rows;
  const lower = typed.toLowerCase();
  const at = rows.findIndex((row) => row.kind === "query" && row.title.toLowerCase() === lower);
  const search = mobileResolve(typed);
  if (at < 0 || !search) return rows;
  const row: TrayRow = { key: `b:${lower}`, kind: "browseForMe", title: BROWSE_FOR_ME, detail: typed, url: search.url, query: typed };
  return [...rows.slice(0, at + 1), row, ...rows.slice(at + 1)].slice(0, ROW_LIMIT);
}

export function withTypedQuery(rows: TrayRow[], text: string): TrayRow[] {
  const typed = text.trim();
  const lower = typed.toLowerCase();
  if (rows.some((row) => row.kind === "query" && row.title.toLowerCase() === lower)) return rows.slice(0, ROW_LIMIT);
  const resolution = mobileResolve(typed);
  if (!resolution) return rows.slice(0, ROW_LIMIT);
  const row: TrayRow = { key: `q:${typed}`, kind: "query", title: typed, url: resolution.url, query: typed, detail: resolution.kind === "bang" ? `Search ${resolution.engine}` : null };
  const kept = rows.filter((existing) => existing.key !== row.key);
  return [...kept.slice(0, Math.min(1, kept.length)), row, ...kept.slice(Math.min(1, kept.length))].slice(0, ROW_LIMIT);
}

function addressRow(url: string): TrayRow {
  const host = displayHost(mobileDisplay(url, "").host, url);
  return { key: `p::${url}`, kind: "page", title: host, detail: host, url, favicon: null, tabId: null, switchesTab: false };
}

export type RowTarget = { url: string; origin: "search" | "typed" | "sync" };

export function rowTarget(row: TrayRow): RowTarget | null {
  if (row.kind === "calc" || row.kind === "paste" || row.kind === "browseForMe") return null;
  if (row.kind === "page") return { url: row.url, origin: row.fromMac ? "sync" : "typed" };
  const typed = mobileResolve(row.query);
  return typed?.kind === "url" ? { url: typed.url, origin: "typed" } : { url: row.url, origin: "search" };
}

export function enterTarget(text: string): RowTarget | null {
  const resolution = mobileResolve(text);
  return resolution ? { url: resolution.url, origin: resolution.kind === "url" ? "typed" : "search" } : null;
}

export function idleRows(queries: readonly string[], macTabs: readonly { url: string; title: string; deviceName: string; favicon?: string | null }[] = []): TrayRow[] {
  const rows: TrayRow[] = [];
  for (const query of queries) {
    const url = mobileResolve(`?${query}`)?.url;
    if (url) rows.push({ key: `q:${query}`, kind: "query", title: query, url, query });
  }
  for (const tab of macTabs) {
    const host = displayHost(mobileDisplay(tab.url, tab.title).host, tab.url);
    rows.push({ key: `r:${tab.url}`, kind: "page", title: tab.title || tab.url, detail: host, url: tab.url, favicon: tab.favicon ?? null, tabId: null, switchesTab: false, fromMac: tab.deviceName });
  }
  return rows.slice(0, IDLE_ROW_LIMIT);
}

export function withCurrentEngine(rows: readonly TrayRow[]): TrayRow[] {
  return rows.flatMap((row): TrayRow[] => {
    if (row.kind !== "query") return [row];
    const url = mobileResolve(`?${row.query}`)?.url;
    return url ? [{ ...row, url }] : [];
  });
}

export const searchEngines = () => mobileEngines().map((engine) => ({ id: engine.id, name: engine.name, custom: engine.custom }));

export const resolve = (text: string) => mobileResolve(text);

export const display = (url: string) => mobileDisplay(url);

export const setSources = (sources: OmniboxSources) => mobileSetSources(sources);

let engineIdentity = "";
let engineRevision = 0;

export const searchEngineRevision = () => engineRevision;

function chooseSearch(search: Parameters<typeof mobileSetSearch>[0]) {
  const identity = JSON.stringify(search);
  const chosen = mobileSetSearch(search);
  if (identity !== engineIdentity) {
    engineIdentity = identity;
    engineRevision += 1;
  }
  return chosen;
}

export const setSearchEngine = (engineId: string) => chooseSearch({ engineId });

export const setSyncedSearch = (search: { engineId: string; customURL: string | null; customEngines: { id: string; name: string; keyword: string; url: string }[] }) =>
  chooseSearch({ engineId: search.engineId, customUrl: search.customURL ?? undefined, customEngines: search.customEngines });

const REMOTE_TIMEOUT_MS = 4000;

export type RemoteOutcome = { values: string[]; status: "ok" | "none" | "http" | "failed" | "timeout" };

export async function remoteSuggestions(text: string, signal: AbortSignal): Promise<RemoteOutcome> {
  const address = mobileSuggestRequest(text);
  if (!address) return { values: [], status: "none" };
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, REMOTE_TIMEOUT_MS);
  const cancel = () => timeout.abort();
  signal.addEventListener("abort", cancel);
  try {
    const response = await fetch(address, { headers: { Accept: "application/json" }, signal: timeout.signal });
    if (response.status !== 200) return { values: [], status: "http" };
    return { values: mobileParseRemote(await response.text()), status: "ok" };
  } catch {
    return { values: [], status: timedOut ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

export const refinedText = (row: TrayRow) => (row.kind === "query" ? `${row.query.trim()} ` : row.title);

export function queryPrefixLength(title: string, typed: string): number {
  const needle = typed.trim();
  if (!needle || title.length <= needle.length) return 0;
  return title.toLowerCase().startsWith(needle.toLowerCase()) ? needle.length : 0;
}
