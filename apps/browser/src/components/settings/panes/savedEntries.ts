import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedPassword } from "../../../state/site/passwords";
import { siteLabel } from "../../../state/vaults/originMatch";
import type { VaultItem } from "../../../state/vaults/types";
import { hostLabel, queryWords, searchText } from "../../pages/PageLayout";
import { itemUrl } from "../../vaults/rowText";

export type SavedEntry = { key: string; site: string; username: string; url: string; hay: string; saved?: SavedPassword; item?: VaultItem };

const BY_SITE = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const bySite = (a: SavedEntry, b: SavedEntry) => BY_SITE.compare(a.site, b.site) || BY_SITE.compare(a.username, b.username);

export const savedEntries = (saved: readonly SavedPassword[]): SavedEntry[] =>
  saved.map((p) => ({ key: `saved|${p.origin}|${p.username}`, site: hostLabel(p.origin), username: p.username, url: p.origin, hay: searchText(p.origin, p.username), saved: p })).sort(bySite);

export function loginEntries(logins: readonly VaultItem[]): SavedEntry[] {
  return logins
    .map((item) => {
      const url = itemUrl(item);
      const site = url ? siteLabel(url) : item.title;
      return { key: `vault|${item.provider}|${item.id}`, site, username: item.username, url, hay: searchText(url || site, item.username, item.title), item };
    })
    .sort(bySite);
}

export function mergeSorted(a: readonly SavedEntry[], b: readonly SavedEntry[]): readonly SavedEntry[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const out: SavedEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(bySite(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

function matching(entries: readonly SavedEntry[], query: string): readonly SavedEntry[] {
  const words = queryWords(query);
  const keeps = (e: SavedEntry) => words.every((w) => e.hay.includes(w));
  const firstOut = words.length ? entries.findIndex((e) => !keeps(e)) : -1;
  if (firstOut < 0) return entries;
  const kept = entries.slice(0, firstOut);
  for (let i = firstOut + 1; i < entries.length; i++) if (keeps(entries[i]!)) kept.push(entries[i]!);
  return kept;
}

export function useNextFrame<T>(value: T): T {
  const [later, setLater] = useState(value);
  useEffect(() => {
    if (later === value) return;
    const frame = requestAnimationFrame(() => setLater(value));
    return () => cancelAnimationFrame(frame);
  }, [value, later]);
  return later;
}

export function useNarrowedEntries(entries: readonly SavedEntry[], query: string): readonly SavedEntry[] {
  const last = useRef<{ entries: readonly SavedEntry[]; query: string; shown: readonly SavedEntry[] } | null>(null);
  return useMemo(() => {
    const was = last.current;
    const narrower = !!was && was.entries === entries && query.toLowerCase().startsWith(was.query.toLowerCase()) && !/\s/.test(query.slice(was.query.length));
    const shown = matching(narrower ? was.shown : entries, query);
    last.current = { entries, query, shown };
    return shown;
  }, [entries, query]);
}
