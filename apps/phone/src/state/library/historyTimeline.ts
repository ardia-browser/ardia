import { t } from "../../lib/uiLanguage";
export type HistorySource = "thisDevice" | "otherDevice";

export type HistoryEntry = { url: string; title: string; visitedAt: number; source: HistorySource };

export type HistoryVisitInput = { url: string; title: string; visitedAt: number };

export type HistoryDay = { day: number; entries: HistoryEntry[] };

export type HiddenHistory = Readonly<Record<string, number>>;

export const SAME_VISIT_TOLERANCE_MS = 2000;

const isVisible = (visit: HistoryVisitInput, hidden: HiddenHistory) => {
  const cutoff = hidden[visit.url];
  return cutoff === undefined || visit.visitedAt > cutoff + SAME_VISIT_TOLERANCE_MS;
};

export function historyEntries(local: readonly HistoryVisitInput[], synced: readonly HistoryVisitInput[], hidden: HiddenHistory): HistoryEntry[] {
  const byUrl = new Map<string, HistoryEntry>();
  for (const visit of local) {
    if (!isVisible(visit, hidden)) continue;
    const existing = byUrl.get(visit.url);
    if (existing && existing.visitedAt >= visit.visitedAt) {
      if (!existing.title && visit.title) existing.title = visit.title;
      continue;
    }
    byUrl.set(visit.url, { url: visit.url, title: visit.title || existing?.title || "", visitedAt: visit.visitedAt, source: "thisDevice" });
  }
  for (const visit of synced) {
    if (!isVisible(visit, hidden)) continue;
    const existing = byUrl.get(visit.url);
    if (!existing) {
      byUrl.set(visit.url, { url: visit.url, title: visit.title, visitedAt: visit.visitedAt, source: "otherDevice" });
      continue;
    }
    if (visit.visitedAt <= existing.visitedAt + SAME_VISIT_TOLERANCE_MS) {
      if (!existing.title && visit.title) existing.title = visit.title;
      continue;
    }
    byUrl.set(visit.url, { url: visit.url, title: visit.title || existing.title, visitedAt: visit.visitedAt, source: "otherDevice" });
  }
  return [...byUrl.values()].sort((a, b) => (a.visitedAt === b.visitedAt ? (a.url < b.url ? -1 : a.url > b.url ? 1 : 0) : b.visitedAt - a.visitedAt));
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

export function filterHistory(entries: readonly HistoryEntry[], query: string): readonly HistoryEntry[] {
  const needles = words(query);
  if (!needles.length) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.title} ${entry.url}`.toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
}

const startOfDay = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

export function historyDays(entries: readonly HistoryEntry[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const day = startOfDay(entry.visitedAt);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

export type HistoryDayLabel = "today" | "yesterday" | "weekday" | "date";

export function historyDayLabel(day: number, now: number): HistoryDayLabel {
  const distance = Math.round((startOfDay(now) - startOfDay(day)) / 86_400_000);
  if (distance <= 0) return "today";
  if (distance === 1) return "yesterday";
  if (distance < 7) return "weekday";
  return "date";
}

export function historyDayTitle(day: number, now: number, locale?: string): string {
  const date = new Date(startOfDay(day));
  switch (historyDayLabel(day, now)) {
    case "today":
      return t(`Today`);
    case "yesterday":
      return t(`Yesterday`);
    case "weekday":
      return date.toLocaleDateString(locale, { weekday: "long" });
    case "date":
      return date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
  }
}

export function hidingEntry(entry: HistoryEntry, hidden: HiddenHistory): HiddenHistory {
  return { ...hidden, [entry.url]: Math.max(entry.visitedAt, hidden[entry.url] ?? -Infinity) };
}

export function keepingHidden(hidden: HiddenHistory, stillIn: readonly HistoryVisitInput[]): HiddenHistory {
  const urls = new Set(stillIn.map((visit) => visit.url));
  return Object.fromEntries(Object.entries(hidden).filter(([url]) => urls.has(url)));
}

export function forgettingHidden(hidden: HiddenHistory, since: number | null): HiddenHistory {
  if (since === null) return {};
  return Object.fromEntries(Object.entries(hidden).filter(([, at]) => at < since));
}

export function historyHost(url: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i.exec(url)?.[1];
  if (!host) return url;
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}
