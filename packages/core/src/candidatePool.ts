import { logVisits, pageText, pageTexts, tabPageText, type PageText, withRootSlash } from "./pageText.ts";
import type { SuggestionSource } from "./suggestion.ts";

type HistoryRow = SuggestionSource["history"][number];
type BookmarkRow = NonNullable<SuggestionSource["bookmarks"]>[number];
type TabRow = SuggestionSource["tabs"][number];

export type Candidate = {
  url: string;
  title: string;
  pageTitle?: string;
  renamed?: true;
  favicon: string | null;
  visits: number;
  lastVisit: number;
  logVisits: number;
  bookmarked: boolean;
  tabId?: string;
  fresh?: boolean;
  text: PageText;
  named?: PageText;
  openIn?: OpenMark;
  openTabId?: string;
  openRenamed?: boolean;
};

type Lookup = { get(key: string): Candidate | undefined; has(key: string): boolean };
export type Pool = { list: Candidate[]; byKey: Lookup; byDocument: Pick<Lookup, "get"> };

type BookmarkBase = { list: Candidate[]; byKey: Map<string, Candidate>; byDocument: Map<string, Candidate>; cursor: number; done: boolean };
type Builder = {
  base: BookmarkBase;
  history: readonly HistoryRow[];
  list: Candidate[];
  byKey: Map<string, Candidate>;
  byDocument: Map<string, Candidate>;
  historyCursor: number;
  bookmarkCursor: number;
  pool: Pool | null;
};

const bases = new WeakMap<readonly BookmarkRow[], BookmarkBase>();
const builders = new WeakMap<readonly HistoryRow[], WeakMap<readonly BookmarkRow[], Builder>>();
export const NO_BOOKMARKS: readonly BookmarkRow[] = [];
const historyCandidates = new WeakMap<HistoryRow, Candidate>();
const SLICE_CHECK = 64;

function baseFor(bookmarks: readonly BookmarkRow[]): BookmarkBase {
  let base = bases.get(bookmarks);
  if (!base) bases.set(bookmarks, (base = { list: [], byKey: new Map(), byDocument: new Map(), cursor: 0, done: false }));
  return base;
}

function addTo(byKey: Map<string, Candidate>, byDocument: Map<string, Candidate>, c: Candidate) {
  byKey.set(c.text.key, c);
  if (c.text.document !== undefined && !byDocument.has(c.text.document)) byDocument.set(c.text.document, c);
}

function advance(b: Builder, bookmarks: readonly BookmarkRow[], deadline: number): boolean {
  if (b.pool) return true;
  let n = 0;
  const late = () => ++n % SLICE_CHECK === 0 && Date.now() > deadline;
  const base = b.base;
  while (!base.done && base.cursor < bookmarks.length) {
    const row = bookmarks[base.cursor++]!;
    const text = pageText(row);
    if (!base.byKey.has(text.key)) {
      const c: Candidate = { url: row.url, title: row.title, favicon: row.favicon, visits: 0, lastVisit: 0, logVisits: 0, bookmarked: true, text };
      base.list.push(c);
      addTo(base.byKey, base.byDocument, c);
    }
    if (late()) return false;
  }
  base.done = true;
  while (b.historyCursor < b.history.length) {
    const h = b.history[b.historyCursor++]!;
    const text = pageText(h);
    if (!b.byKey.has(text.key)) {
      const mark = base.byKey.get(text.key);
      const named = mark?.title && mark.text.titleLower !== text.titleLower && withRootSlash(mark.url) === withRootSlash(h.url) ? mark.text : undefined;
      let c = historyCandidates.get(h);
      if (!c || c.bookmarked !== !!mark || c.named !== named) {
        c = { url: h.url, title: named ? mark!.title : h.title, pageTitle: named ? h.title : undefined, favicon: h.favicon, visits: h.visits, lastVisit: h.lastVisit, logVisits: logVisits(h.visits), bookmarked: !!mark, text, named };
        historyCandidates.set(h, c);
      }
      b.list.push(c);
      addTo(b.byKey, b.byDocument, c);
    }
    if (late()) return false;
  }
  while (b.bookmarkCursor < base.list.length) {
    const c = base.list[b.bookmarkCursor++]!;
    if (!b.byKey.has(c.text.key)) b.list.push(c);
    if (late()) return false;
  }
  const history = b.byKey;
  const historyDocuments = b.byDocument;
  b.pool = {
    list: b.list,
    byKey: { get: (key) => history.get(key) ?? base.byKey.get(key), has: (key) => history.has(key) || base.byKey.has(key) },
    byDocument: { get: (document) => historyDocuments.get(document) ?? base.byDocument.get(document) },
  };
  return true;
}

function builderFor(history: readonly HistoryRow[], bookmarks: readonly BookmarkRow[]): Builder {
  let byBookmarks = builders.get(history);
  if (!byBookmarks) builders.set(history, (byBookmarks = new WeakMap()));
  let b = byBookmarks.get(bookmarks);
  if (!b) byBookmarks.set(bookmarks, (b = { base: baseFor(bookmarks), history, list: [], byKey: new Map(), byDocument: new Map(), historyCursor: 0, bookmarkCursor: 0, pool: null }));
  return b;
}

export function poolFor(history: readonly HistoryRow[], bookmarks: readonly BookmarkRow[]): Pool {
  const b = builderFor(history, bookmarks);
  advance(b, bookmarks, Infinity);
  return b.pool!;
}

export function prepareSuggestions(source: SuggestionSource, deadline: number): boolean {
  const bookmarks = source.bookmarks ?? NO_BOOKMARKS;
  const b = builderFor(source.history, bookmarks);
  if (b.pool) return true;
  for (const rows of [source.history, bookmarks]) {
    let n = 0;
    for (const row of rows) {
      if (pageTexts.has(row)) continue;
      pageText(row);
      if (++n % SLICE_CHECK === 0 && Date.now() > deadline) return false;
    }
  }
  return advance(b, bookmarks, deadline);
}

const exactIndexes = new WeakMap<readonly { url: string }[], Map<string, { url: string }>>();

function exactRows<Row extends { url: string }>(rows: readonly Row[]): Map<string, Row> {
  let index = exactIndexes.get(rows) as Map<string, Row> | undefined;
  if (!index) {
    index = new Map();
    for (const row of rows) {
      const key = withRootSlash(row.url);
      if (!index.has(key)) index.set(key, row);
    }
    exactIndexes.set(rows, index);
  }
  return index;
}

export const savedVisit = (history: readonly HistoryRow[], url: string): HistoryRow | undefined => exactRows(history).get(withRootSlash(url));
export const savedBookmark = (bookmarks: readonly BookmarkRow[], url: string): BookmarkRow | undefined => exactRows(bookmarks).get(withRootSlash(url));

export type OpenMark = Record<string, never>;
export type TabsOver = { pool: Pool; currentTabId: string | undefined; rows: TabRow[]; tabIds: Map<string, string>; extra: Candidate[]; renamed: Set<string>; mark: OpenMark };
const tabsOverCache = new WeakMap<readonly TabRow[], TabsOver>();
let lastMarked: OpenMark | null = null;

function marked(result: TabsOver): TabsOver {
  if (lastMarked === result.mark) return result;
  for (const [key, tabId] of result.tabIds) {
    const c = result.pool.byKey.get(key);
    if (c) {
      c.openIn = result.mark;
      c.openTabId = tabId;
      c.openRenamed = false;
    }
  }
  lastMarked = result.mark;
  return result;
}

export function tabsOver(pool: Pool, tabs: readonly TabRow[], currentTabId?: string): TabsOver {
  const cached = tabsOverCache.get(tabs);
  if (cached && cached.pool === pool && cached.currentTabId === currentTabId && cached.rows.length === tabs.length) {
    let same = true;
    for (let i = 0; same && i < tabs.length; i++) same = cached.rows[i] === tabs[i];
    if (same) return marked(cached);
  }
  const tabIds = new Map<string, string>();
  const renamedTabKeys = new Set<string>();
  const firstOfPage: boolean[] = new Array(tabs.length);
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]!;
    if (!t.url || t.id === currentTabId) continue;
    const key = pageText(t).key;
    if (!t.customTitle) {
      if (!tabIds.has(key)) {
        tabIds.set(key, t.id);
        firstOfPage[i] = true;
      }
    } else if (!renamedTabKeys.has(key)) {
      renamedTabKeys.add(key);
      tabIds.set(key, t.id);
    }
  }
  const extra: Candidate[] = [];
  const renamed = new Set<string>();
  const mark: OpenMark = {};
  const result: TabsOver = { pool, currentTabId, rows: tabs.slice(), tabIds, extra, renamed, mark };
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]!;
    if (!t.url || t.id === currentTabId) continue;
    const key = pageText(t).key;
    const listed = pool.byKey.get(key);
    if (listed && (listed.openIn !== mark || (t.customTitle && !listed.openRenamed))) {
      listed.openIn = mark;
      listed.openTabId = t.id;
      listed.openRenamed = !!t.customTitle;
    }
    if (!t.customTitle) {
      if (!listed && firstOfPage[i] && (renamedTabKeys.size === 0 || !renamedTabKeys.has(key))) extra.push({ url: t.url, title: t.title, pageTitle: t.title, favicon: t.favicon, visits: 0, lastVisit: 0, logVisits: 0, fresh: true, bookmarked: false, tabId: t.id, text: tabPageText(t) });
    } else if (!listed) {
      extra.push({ url: t.url, title: t.customTitle, pageTitle: t.title, renamed: true, favicon: t.favicon, visits: 0, lastVisit: 0, logVisits: 0, fresh: true, bookmarked: false, tabId: t.id, text: tabPageText(t) });
    } else {
      renamed.add(key);
      extra.push({ url: t.url, title: t.customTitle, renamed: true, favicon: t.favicon ?? listed.favicon, visits: listed.visits, lastVisit: listed.lastVisit, logVisits: listed.logVisits, bookmarked: listed.bookmarked, tabId: t.id, text: tabPageText(t, listed.text), named: listed.named });
    }
  }
  tabsOverCache.set(tabs, result);
  lastMarked = result.mark;
  return result;
}
