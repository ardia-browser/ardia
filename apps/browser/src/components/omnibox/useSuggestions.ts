import {
  buildSuggestions,
  createSuggestFetcher,
  engineById,
  findBang,
  prepareSuggestions,
  suggestRequestUrl,
  type RemoteSite,
  type SearchEngine,
  type SearchScope,
  type SuggestionResult,
} from "@ardia/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { noteLateSuggestionsBelow, noteSiteSuggestionShown } from "../../state/telemetry/inlineCompletionCounts";
import { bookmarksByUrl } from "../../state/bookmarks/bookmarks";
import { useMenuBarRevision } from "../../state/commands/commandShortcuts";
import { useSettings } from "../../state/browser/hooks";
import { useBookmarkEngine, useBookmarks, useBookmarksShown } from "../../state/bookmarks/hooks";
import { useSuggestionHistory } from "../../state/history/hooks";
import { useTabs } from "../../state/tabs/hooks";
import { useProfileRecords } from "../../state/profiles/hooks";
import { searchedTabs, searchesAllProfiles, withTabProfiles } from "../../state/tabs/tabsInAllProfiles";
import { defaultSearchEngine, searchEngines } from "../../state/settings/settings";
import type { Bookmarks } from "../../state/browser/types";
import { currentBarActions } from "../../state/omnibox/barActions";
import { useBangs } from "../../state/omnibox/bangs";
import { useBarExtensions } from "./extensions";
import { historyHosts } from "../../state/omnibox/knownHosts";
import { useProviderSections } from "./useProviderSections";
import { barFieldMarks } from "../../state/omnibox/barMarks";
import { browserSuggestFetch, remoteSuggestionsAllowed, suggestProfileKey } from "../../state/omnibox/suggestTransport";
import { during } from "../../state/app/jobActivity";
import { addsRows, answered, askedKey, remoteListFor, remoteSitesFor, type Remote } from "./lateRemote";

const NO_SITES: RemoteSite[] = [];
const EMPTY: SuggestionResult = { items: [], completion: "" };
const WARM_SLICE_MS = 4;
const REMOTE_PATIENCE_MS = 1500;

type BookmarkRow = { url: string; title: string; favicon: string | null };
const bookmarkCache = new WeakMap<Bookmarks, Map<string, BookmarkRow[]>>();
const NO_BOOKMARKS: BookmarkRow[] = [];

function engineBookmarks(b: Bookmarks, engine: string): BookmarkRow[] {
  let perEngine = bookmarkCache.get(b);
  if (!perEngine) bookmarkCache.set(b, (perEngine = new Map()));
  let rows = perEngine.get(engine);
  if (!rows) {
    rows = [];
    for (const [url, ids] of bookmarksByUrl(b, engine)) {
      const node = b.nodes[ids[0]!];
      if (node?.kind === "url") rows.push({ url, title: node.title, favicon: node.favicon });
    }
    perEngine.set(engine, rows);
  }
  return rows;
}

function suggestEngine(scope: SearchScope | null, engines: SearchEngine[], fallback: SearchEngine): SearchEngine {
  return scope?.kind === "engine" ? engineById(engines, scope.engineId) : fallback;
}

export function useSuggestions({
  text,
  active,
  windowId,
  profileId,
  currentTabId,
  currentUrl,
  scope,
  preventInline,
  switchToOpenTab,
}: {
  text: string;
  active: boolean;
  windowId: string;
  profileId: string;
  currentTabId?: string;
  currentUrl?: string;
  scope: SearchScope | null;
  preventInline?: boolean;
  switchToOpenTab?: boolean;
}): SuggestionResult {
  const allTabs = useTabs((tabs) => tabs);
  const historyOn = useSettings((st) => st.commandBarHistory);
  const history = useSuggestionHistory(historyOn ? profileId : null);
  const bookmarks = useBookmarks((b) => b);
  const bookmarkEngine = useBookmarkEngine(windowId);
  const engines = useSettings((st) => searchEngines(st));
  const engine = useSettings((st) => defaultSearchEngine(st));
  const suggestionsOn = useSettings((st) => st.searchSuggestions);
  const extensions = useBarExtensions(windowId);
  const shortcuts = useSettings((st) => st.shortcuts);
  const menuBar = useMenuBarRevision();
  const allProfiles = useSettings((st) => searchesAllProfiles(st.searchTabsInAllProfiles, profileId));
  const profiles = useProfileRecords();

  const tabs = useMemo(() => searchedTabs(allTabs, profileId, allProfiles), [allTabs, profileId, allProfiles]);
  const showBookmarks = useBookmarksShown();
  const bookmarkRows = useMemo(() => (showBookmarks ? engineBookmarks(bookmarks, bookmarkEngine) : NO_BOOKMARKS), [showBookmarks, bookmarks, bookmarkEngine]);
  const source = useMemo(() => ({ tabs, history, bookmarks: bookmarkRows }), [tabs, history, bookmarkRows]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      timer = prepareSuggestions(source, Date.now() + WARM_SLICE_MS) ? undefined : setTimeout(step, 16);
      if (!timer) historyHosts(source.history);
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [source]);

  const [remote, setRemote] = useState<Remote>({ text: "", engine: "", list: [], sites: NO_SITES });
  const drawnRemote = useRef(remote);
  const attempts = useRef({ asking: "", count: 0 });
  drawnRemote.current = remote;
  const suggestProfile = suggestProfileKey(profileId);
  const remoteAllowed = remoteSuggestionsAllowed(profileId);
  const fetcher = useMemo(() => createSuggestFetcher({ fetch: browserSuggestFetch(suggestProfile) }), [suggestProfile]);
  useEffect(() => {
    setRemote({ text: "", engine: "", list: [], sites: NO_SITES });
    return () => fetcher.cancel();
  }, [fetcher]);
  const query = text.trim();
  const fromEngine = suggestEngine(scope, engines, engine);
  const bangs = useBangs(active && !scope && query.includes("!"));
  const bang = useMemo(() => (bangs ? findBang(query, bangs) : null), [bangs, query]);
  const asked = query.replace(/^\?/, "").trim();
  const remoteQuery = active && suggestionsOn && remoteAllowed && asked && !bang && !/^[a-z][a-z0-9+.-]*:\/\//i.test(asked) && scope?.kind !== "history" && scope?.kind !== "provider" && suggestRequestUrl(fromEngine, asked) ? asked : null;
  const sitesShown = !scope;
  const asking = remoteQuery === null ? "" : `${suggestProfile}\n${sitesShown}\n${fromEngine.id}\n${query}`;
  if (attempts.current.asking !== asking) attempts.current = { asking, count: attempts.current.count + 1 };
  const attempt = askedKey(fromEngine.id, query, attempts.current.count);
  useEffect(() => {
    if (!remoteQuery) {
      fetcher.cancel();
      return;
    }
    const key = attempt;
    const gaveUp = () => setRemote((r) => (r.gaveUp === key ? r : { ...r, gaveUp: key }));
    const patience = setTimeout(gaveUp, REMOTE_PATIENCE_MS);
    fetcher.request(
      fromEngine,
      remoteQuery,
      (list, sites) => {
        clearTimeout(patience);
        if (addsRows(drawnRemote.current, answered(drawnRemote.current, query, fromEngine.id, list, sites, key), query, fromEngine.id, sitesShown)) noteLateSuggestionsBelow();
        setRemote((r) => answered(r, query, fromEngine.id, list, sites, key));
      },
      gaveUp,
    );
    return () => clearTimeout(patience);
  }, [remoteQuery, query, fromEngine, fetcher, attempt, sitesShown]);
  const remotePending = remoteQuery !== null && !(remote.text === query && remote.engine === fromEngine.id) && remote.gaveUp !== attempt;

  const providers = useProviderSections({ text, active, scope, windowId, skip: !!bang });

  const remoteList = useMemo(() => remoteListFor(remote, query, fromEngine.id), [remote, query, fromEngine.id]);

  const remoteSites = useMemo(() => remoteSitesFor(remote, query, fromEngine.id), [remote, query, fromEngine.id]);

  const result = useMemo(() => {
    if (!active || (!query && scope?.kind !== "provider")) return EMPTY;
    const started = performance.now();
    const built = during("omniboxSuggest", () => buildSuggestions(text, source, {
      engine,
      preference: "website",
      remote: remoteList,
      remoteSites: scope ? NO_SITES : remoteSites,
      actions: currentBarActions(windowId),
      extensions,
      currentTabId,
      currentUrl,
      scope,
      preventInline,
      switchToOpenTab,
      remotePending,
      bangs,
      providers,
    }));
    barFieldMarks.suggestions(performance.now() - started, text.length);
    return allProfiles ? withTabProfiles(built, allTabs, profileId, profiles) : built;
  }, [active, text, query, source, engine, remoteList, remoteSites, windowId, extensions, shortcuts, menuBar, currentTabId, currentUrl, scope, preventInline, switchToOpenTab, remotePending, bangs, providers, allProfiles, allTabs, profileId, profiles]);
  const siteListed = !scope && remoteSites.some((site) => result.items.some((i) => i.kind === "page" && i.url === site.url && !i.tabId));
  useEffect(() => {
    if (siteListed) noteSiteSuggestionShown();
  }, [siteListed, query]);
  return result;
}
