import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedPassword } from "../../../state/site/passwords";
import { siteLabel } from "../../../state/vaults/originMatch";
import type { VaultItem } from "../../../state/vaults/types";
import type { PaneRows, VaultPaneRow } from "../../../state/vaults/paneRows";
import { hostLabel, queryWords, searchText } from "../../pages/PageLayout";
import { itemUrl } from "../../vaults/rowText";

export type SavedEntry = { key: string; site: string; username: string; url: string; hay: string; saved?: SavedPassword; item?: VaultItem };

const BY_SITE = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const bySite = (a: SavedEntry, b: SavedEntry) => BY_SITE.compare(a.site, b.site) || BY_SITE.compare(a.username, b.username);

const savedEntry = (p: SavedPassword): SavedEntry => ({ key: `saved|${p.origin}|${p.username}`, site: hostLabel(p.origin), username: p.username, url: p.origin, hay: searchText(p.origin, p.username), saved: p });

function loginEntry(item: VaultItem): SavedEntry {
  const url = itemUrl(item);
  const site = url ? siteLabel(url) : item.title;
  return { key: `vault|${item.provider}|${item.id}`, site, username: item.username, url, hay: searchText(url || site, item.username, item.title), item };
}

export const savedEntries = (saved: readonly SavedPassword[]): SavedEntry[] => saved.map(savedEntry).sort(bySite);

export const paneEntry = (row: VaultPaneRow): SavedEntry => (row.saved ? savedEntry(row.saved) : loginEntry(row.item!));

export function useLocalPaneRows(list: readonly SavedPassword[] | null, query: string): PaneRows {
  const saved = useMemo(() => savedEntries(list ?? []), [list]);
  const shown = useNarrowedEntries(saved, query);
  return useMemo<PaneRows>(
    () => ({
      key: `${query}`,
      total: shown.length,
      listed: saved.length,
      ready: list !== null,
      rowAt: (index) => {
        const entry = shown[index];
        return entry?.saved ? { saved: entry.saved } : undefined;
      },
      want: () => undefined,
    }),
    [shown, saved, list, query],
  );
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
