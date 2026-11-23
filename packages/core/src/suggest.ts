import { findBang, type BangMatch } from "./bangs.ts";
import { calculate } from "./calculator.ts";
import { NO_BOOKMARKS, poolFor, savedBookmark, savedVisit, tabsOver, type Candidate } from "./candidatePool.ts";
import { extensionSuggestions } from "./extensionRows.ts";
import { BUILT_IN_ENGINES, searchUrl } from "./engines.ts";
import { matchActions } from "./fuzzy.ts";
import { fixupUrl, hostOf, sameAddress, searchUrlFor, spacedAddressGuess } from "./omnibox.ts";
import { leadingRows, matchScore, matchScoreWord, narrowing, parseQuery, remember, TabList, TopList, type Ranked } from "./pageMatch.ts";
import { hostLowerOfPage, hostOfPage, hostPart, originOfPage, pageKey, type PageText, withRootSlash } from "./pageText.ts";
import { globalProviderRows, providerUrl, safeProviderRows, type ProviderSection, type ProviderSuggestion } from "./providerRows.ts";
import { matchQuickCreate } from "./quickCreate.ts";
import { scopedSearchUrl, type SearchScope } from "./siteSearch.ts";
import type { SuggestionResult, SuggestionSource, SuggestOptions, Suggestion, SuggestionVia } from "./suggestion.ts";
import { actionRow, createRow, dedupeSuggestions, Output, pageSuggestion, suggestionKey, type PageRow } from "./suggestionRows.ts";

export type { CommandAction, Suggestion, SuggestionResult, SuggestionSource, SuggestionVia, SuggestOptions } from "./suggestion.ts";
export { displayUrl } from "./pageText.ts";
export { prepareSuggestions } from "./candidatePool.ts";
export { dedupeSuggestions, suggestionKey } from "./suggestionRows.ts";

const DAY = 86_400_000;
const lowerOrigin = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, (origin) => origin.toLowerCase());
const withoutFragment = (url: string) => url.replace(/#.*$/, "");

export function buildSuggestions(raw: string, source: SuggestionSource, options: SuggestOptions = {}): SuggestionResult {
  const { limit = 8, now = Date.now(), engine = BUILT_IN_ENGINES[0]!, preference = "website", remote = [], actions = [], scope, preventInline = false } = options;
  const query = raw.trim();
  if (scope?.kind === "provider") return providerScopeSuggestions(query, scope, options.providers ?? [], limit);
  if (!query) return { items: [], completion: "" };
  const bare = query[0] === "h" || query[0] === "H" ? query.replace(/^https?:\/\/(?=\S)/i, "") : query;
  const q = bare.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  const bang = scope ? null : findBang(query, options.bangs);
  if (bang) return bangSuggestions(bang, source, options, limit);

  if (!scope && query.startsWith("?")) {
    const text = query.slice(1).trim();
    if (!text) return { items: [], completion: "" };
    const out = new Output(limit);
    out.push({ kind: "search", query: text, url: searchUrl(engine, text), engine: engine.name });
    out.push(...dedupeSuggestions(remote, text).slice(0, 4).map((t): Suggestion => ({ kind: "search", query: t, url: searchUrl(engine, t), engine: engine.name, suggested: true })));
    return { items: out.items, completion: "" };
  }

  const pool = poolFor(source.history, source.bookmarks ?? NO_BOOKMARKS);
  const { tabIds, extra, renamed } = tabsOver(pool, source.tabs, options.currentTabId);
  const currentKey = options.currentUrl ? pageKey(options.currentUrl) : null;
  const via = new Map<Suggestion, SuggestionVia>();
  const tag = (s: Suggestion, as: SuggestionVia | false | undefined): Suggestion => {
    if (as) via.set(s, as);
    return s;
  };
  const known = (url: string) => {
    const key = pageKey(url);
    const c = pool.byKey.get(key) ?? extra.find((x) => x.text.key === key);
    if (!c) return undefined;
    const shown = { ...c, title: c.pageTitle ?? c.title };
    const opened = withRootSlash(url);
    if (withRootSlash(c.url) === opened) return pageSuggestion(shown, null);
    const visit = savedVisit(source.history, opened);
    const bookmark = savedBookmark(source.bookmarks ?? NO_BOOKMARKS, opened);
    const lent = visit ?? bookmark ?? shown;
    const row: PageRow = { url: visit?.url ?? opened, title: lent.title, favicon: lent.favicon, visits: visit?.visits ?? 0, bookmarked: bookmark !== undefined };
    return tag(pageSuggestion(row, null), "literal");
  };
  const openTabAt = (url: string): Suggestion | undefined => {
    if (!options.switchToOpenTab) return undefined;
    const opened = withRootSlash(lowerOrigin(url));
    if (!tabIds.has(pageKey(opened))) return undefined;
    const tab = source.tabs.find((t) => t.url && t.id !== options.currentTabId && withoutFragment(withRootSlash(lowerOrigin(t.url))) === withoutFragment(opened));
    if (!tab) return undefined;
    const visit = savedVisit(source.history, opened);
    const bookmark = savedBookmark(source.bookmarks ?? NO_BOOKMARKS, opened);
    const title = tab.customTitle || visit?.title || bookmark?.title || tab.title;
    return tag(pageSuggestion({ url: opened, title, favicon: tab.favicon ?? visit?.favicon ?? bookmark?.favicon ?? null, visits: visit?.visits ?? 0, bookmarked: bookmark !== undefined }, tab.id), "open_tab");
  };

  const websiteFirst = preference === "website";
  const oneWord = tokens.length === 1;
  const noInline = preventInline || (oneWord && raw.length !== query.length && /\s$/.test(raw));
  const completes = !scope && oneWord && !noInline;
  const from = narrowing(pool, q, tokens);
  const pages = from ? from.pages : pool.list;
  const again = from !== null && from.q === q;
  const parsed = parseQuery(q, tokens);
  const matched: Candidate[] = again ? from.pages : [];
  const scores: number[] = again ? from.scores : [];
  let found = 0;
  const top = new TopList(limit + 1);
  const tabTop = new TabList();
  const typedUrl = scope ? null : fixupUrl(query);
  const guessedUrl = scope || typedUrl ? null : spacedAddressGuess(query);
  const tabUrls = guessedUrl ? new Map(source.tabs.map((t) => [t.id, t.url])) : null;
  const tabUrl = (tabId: string | undefined) => (tabUrls && tabId ? tabUrls.get(tabId) : undefined);
  const listedRow = (x: Ranked) => !guessedUrl || !sameAddress(tabUrl(x.tabId) ?? x.c.url, guessedUrl);
  const onSite = scope ? new TopList(4) : null;
  const score = oneWord ? matchScoreWord : matchScore;
  const bound = Boolean(scope);
  let inline: Ranked | null = null;
  const hiddenByRename = renamed.size > 0 ? renamed : null;
  for (const list of [pages, extra]) {
    const inPages = list === pages;
    for (let at = 0; at < list.length; at++) {
      const c = list[at]!;
      const m = again && inPages ? scores[at]! : c.named ? Math.max(score(c.text, parsed), score(c.named, parsed)) : score(c.text, parsed);
      if (m <= 0) continue;
      if (inPages && !again) {
        matched[found] = c;
        scores[found++] = m;
      }
      const key = c.text.key;
      if (inPages && hiddenByRename !== null && hiddenByRename.has(key)) continue;
      const derank = currentKey !== null && key === currentKey ? 80 : 0;
      const lastVisit = c.fresh ? now : c.lastVisit;
      let age = 10;
      if (lastVisit) {
        const d = (now - lastVisit) / DAY;
        age = d < 0 ? 0 : d > 30 ? 30 : d;
      }
      const base = c.logVisits - age + (c.bookmarked ? 20 : 0);
      const tabId = c.tabId ?? tabIds.get(key);
      if (!bound && !tabId && top.floor >= m + base - derank + 7) {
        if (!completes) continue;
        if (inline === null ? false : inline.s >= m + base - derank + 7) continue;
        if (c.visits <= 0 || !c.text.shownLower.startsWith(q)) continue;
      }
      const s = m + (base + (tabId ? 6 : 0)) - derank;
      let r: Ranked | undefined;
      if (top.floor < s || top.items.length < limit + 1) {
        r = { c, tabId, m, s };
        top.offer(r);
      }
      if (tabId && !bound && (guessedUrl === null || listedRow({ c, tabId, m, s }))) tabTop.offer(r ?? { c, tabId, m, s });
      if (onSite) {
        const host = hostOfPage(c.text);
        if (host === scope!.host || host.endsWith(`.${scope!.host}`)) onSite.offer(r ?? { c, tabId, m, s });
      }
      if (completes && (!inline || s > inline.s) && c.visits > 0 && inlineMatch(c.text, q)) inline = r ?? { c, tabId, m, s };
    }
  }
  remember(pool, q, tokens, matched, scores);
  const ranked = top.items;

  const out = new Output(limit);
  const remoteRows = (url: (text: string) => string, name: string) =>
    dedupeSuggestions(remote, query)
      .slice(0, 4)
      .map((text): Suggestion => ({ kind: "search", query: text, url: url(text), engine: name, suggested: true }));

  if (scope) {
    const scopedUrl = (text: string) => scopedSearchUrl(scope, text, engine);
    out.push({ kind: "search", query, url: scopedUrl(query), engine: scope.name });
    out.push(...remoteRows(scopedUrl, scope.name));
    if (!options.remotePending) out.push(...onSite!.items.map((x) => pageSuggestion(x.c, x.tabId)));
    return { items: out.items, completion: "" };
  }

  const search: Suggestion = { kind: "search", query, url: searchUrl(engine, query), engine: engine.name };
  const calc = calculate(query);
  const creates = matchQuickCreate(raw.trimStart());
  const actionRows = query.length >= 4 ? 4 : 2;
  const actionMatches = matchActions(query, actions, actionRows).filter((m) => m.exact || m.score >= 50);
  const extensionMatches = extensionSuggestions(query, options.extensions ?? []);

  const best = ranked[0];
  const target = inline && inlineTarget(q, inline.c);
  const completion = target ? target.text.slice(bare.length) : "";

  let first: Suggestion;
  if (creates.length && /^\S+\s+\S/.test(query)) first = createRow(creates[0]!);
  else if (actionMatches[0]?.exact) first = actionRow(actionMatches[0].action);
  else if (target && completion) first = openTabAt(target.url) ?? tag(known(target.url) ?? { kind: "page", url: target.url, title: "", favicon: target.favicon }, !websiteFirst && "search_first_inline");
  else if (typedUrl) first = openTabAt(typedUrl) ?? known(typedUrl) ?? { kind: "page", url: typedUrl, title: "", favicon: null };
  else if (extensionMatches.exact) first = extensionMatches.rows[0]!;
  else if (!guessedUrl && websiteFirst && best && best.m >= 40 && (!noInline || typedIsPage(best.c.text, q))) first = tag(pageSuggestion(best.c, best.tabId), best.c.renamed && "renamed_tab");
  else first = search;

  const savedGuess = guessedUrl ? ranked.find((x) => !x.tabId && sameAddress(x.c.url, guessedUrl)) : undefined;
  const guessTab = guessedUrl ? source.tabs.find((t) => t.id !== options.currentTabId && sameAddress(t.url, guessedUrl)) : undefined;
  const guessRow = !guessedUrl ? null : guessTab ? pageSuggestion({ url: guessTab.url, title: guessTab.customTitle || guessTab.title, favicon: guessTab.favicon, visits: 0, bookmarked: false }, guessTab.id) : (known(guessedUrl) ?? (savedGuess ? { ...pageSuggestion(savedGuess.c, null), url: guessedUrl } : { kind: "page", url: guessedUrl, title: "", favicon: null }));
  out.push(first);
  out.push(search);
  if (guessRow) out.push(guessRow);
  if (calc) out.push({ kind: "calc", expression: calc.expression, value: calc.display, url: searchUrl(engine, calc.expression) });
  out.push(...actionMatches.map((m) => actionRow(m.action)));
  out.push(...extensionMatches.rows);
  out.push(...creates.map(createRow));
  const rowOf = (x: Ranked, as: SuggestionVia | false | undefined = x.c.renamed && "renamed_tab"): Suggestion => {
    const url = tabUrl(x.tabId);
    return tag(pageSuggestion(url ? { ...x.c, url } : x.c, x.tabId), as);
  };
  const listed = guessedUrl ? ranked.filter(listedRow) : ranked;
  const lead = leadingRows(listed, tabTop.items);
  out.push(...lead.map((x, i) => rowOf(x, i < 3 ? undefined : "leading_tab")));
  const remoteSites = (options.remoteSites ?? []).slice(0, 2).filter((site) => !guessedUrl || !sameAddress(site.url, guessedUrl));
  out.push(...remoteSites.map((site): Suggestion => known(site.url) ?? tag({ kind: "page", url: site.url, title: site.title, favicon: null }, "engine_site")));
  const providerAt = out.items.length;
  out.push(...remoteRows((text) => searchUrl(engine, text), engine.name));
  const trailing = listed.filter((x) => !lead.includes(x));
  const providerRows = options.providers?.length ? globalProviderRows(options.providers, [...out.items, ...trailing.filter((x) => x.tabId).map((x) => rowOf(x))]) : [];
  const offered = new Set(providerRows.map((row) => pageKey(row.url)));
  if (!options.remotePending) out.push(...trailing.filter((x) => x.tabId || !offered.has(pageKey(x.c.url))).map((x) => rowOf(x)));
  const items = providerRows.length ? [...out.items.slice(0, providerAt), ...providerRows, ...out.items.slice(providerAt)] : out.items;
  if (guessRow && out.items.includes(guessRow)) tag(guessRow, "spaced_address");
  const shownVia = via.size ? viaOf(items, via) : undefined;
  return shownVia ? { items, completion, via: shownVia } : { items, completion };
}

function providerScopeSuggestions(query: string, scope: SearchScope, sections: readonly ProviderSection[], limit: number): SuggestionResult {
  const id = scope.providerId ?? "";
  const items: ProviderSuggestion[] = [];
  const typedUrl = scope.url && query ? providerUrl(searchUrlFor(scope.url, query)) : null;
  if (typedUrl) items.push({ kind: "provider", providerId: id, provider: scope.name, title: query, url: typedUrl, icon: null });
  const section = sections.find((x) => x.id === id);
  const seen = new Set(items.map((x) => x.url));
  if (section) for (const row of safeProviderRows({ id, title: scope.name }, section.rows, limit)) if (!seen.has(row.url) && items.length < limit) items.push(row);
  return { items, completion: "" };
}

function viaOf(items: readonly Suggestion[], via: ReadonlyMap<Suggestion, SuggestionVia>): Record<string, SuggestionVia> | undefined {
  let shown: Record<string, SuggestionVia> | undefined;
  for (const item of items) {
    const as = via.get(item);
    if (as) (shown ??= {})[suggestionKey(item)] = as;
  }
  return shown;
}

function typedIsPage(t: PageText, q: string): boolean {
  return q === t.shownLower || q === hostLowerOfPage(t);
}

function inlineMatch(t: PageText, q: string): boolean {
  if (hostLowerOfPage(t).startsWith(q) && originOfPage(t)) return true;
  return q.includes("/") && !/[?#]/.test(t.shown) && t.shownLower.startsWith(q);
}

function inlineTarget(q: string, c: Candidate): { text: string; url: string; favicon: string | null } {
  const origin = originOfPage(c.text);
  const host = hostPart(c.text.shown);
  if (origin && host.toLowerCase().startsWith(q)) return { text: host, url: `${origin}/`, favicon: c.favicon };
  return { text: c.text.shown, url: c.text.url, favicon: c.favicon };
}

function bangSuggestions(match: BangMatch, source: SuggestionSource, options: SuggestOptions, limit: number): SuggestionResult {
  const { bang, query } = match;
  const out = new Output(limit);
  if (!query) {
    out.push({ kind: "page", url: bang.home, title: bang.name, favicon: null });
    return { items: out.items, completion: "" };
  }
  out.push({ kind: "search", query, url: match.url, engine: bang.name, bang: true });
  const scope: SearchScope = { kind: "site", name: bang.name, host: hostOf(bang.home), url: bang.template };
  out.push(...buildSuggestions(query, source, { ...options, scope, remote: [], bangs: null }).items.slice(1));
  return { items: out.items, completion: "" };
}
