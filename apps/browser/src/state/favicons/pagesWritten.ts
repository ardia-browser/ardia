export type Pages = Record<string, string | null>;
type Profiles = Record<string, { pages: Pages }>;
type PagesWrite = { base: number; pages: string[] };
type Written = { version: number; writes: PagesWrite[] };
const written = new WeakMap<Pages, Written>();
const MAX_WRITE_HOPS = 16;
let lastVersion = 0;

function writtenOf(pages: Pages): Written {
  let entry = written.get(pages);
  if (!entry) written.set(pages, (entry = { version: ++lastVersion, writes: [] }));
  return entry;
}

export function withPages(base: Pages, writes: [string, string | null][]): Pages {
  const next = { ...base };
  for (const [page, uri] of writes) next[page] = uri;
  const from = writtenOf(base);
  const write = { base: from.version, pages: writes.map(([page]) => page) };
  written.set(next, { version: ++lastVersion, writes: [...from.writes.slice(1 - MAX_WRITE_HOPS), write] });
  return next;
}

export function pagesWrittenSince(now: Pages, before: Pages): string[] | null {
  if (now === before) return [];
  const target = written.get(before)?.version;
  const writes = written.get(now)?.writes;
  if (target === undefined || !writes) return null;
  const pages: string[] = [];
  for (let at = writes.length - 1; at >= 0; at--) {
    const write = writes[at]!;
    for (const page of write.pages) pages.push(page);
    if (write.base === target) return pages;
  }
  return null;
}

export type PagesPair = { now: Pages | undefined; before: Pages | undefined };

export function changedPages(f: { profiles: Profiles }, prev: { profiles: Profiles }): PagesPair[] {
  const pairs: PagesPair[] = [];
  for (const key in f.profiles) {
    const now = f.profiles[key]!.pages;
    const before = prev.profiles[key]?.pages;
    if (now !== before) pairs.push({ now, before });
  }
  for (const key in prev.profiles) if (!(key in f.profiles)) pairs.push({ now: undefined, before: prev.profiles[key]!.pages });
  return pairs;
}
