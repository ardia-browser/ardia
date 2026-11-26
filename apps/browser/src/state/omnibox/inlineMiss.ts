import { hostOf } from "@ardia/core";

const TOP_HOSTS = 20;
const MIN_TYPED = 2;

type Visited = { url: string; visits: number };

const topHostCache = new WeakMap<readonly Visited[], string[]>();

const bareHost = (host: string) => host.replace(/^www\./, "");

export function topHistoryHosts(history: readonly Visited[]): string[] {
  let top = topHostCache.get(history);
  if (top) return top;
  const visits = new Map<string, number>();
  for (const entry of history) {
    const host = bareHost(hostOf(entry.url));
    if (host) visits.set(host, (visits.get(host) ?? 0) + Math.max(1, entry.visits || 0));
  }
  top = [...visits].sort((a, b) => b[1] - a[1]).slice(0, TOP_HOSTS).map(([host]) => host);
  topHostCache.set(history, top);
  return top;
}

export type InlineChance = "none" | "offered" | "missed";

export function inlineChance(query: string, completion: string, history: readonly Visited[], preventInline: boolean): InlineChance {
  const typed = query.trim().toLowerCase();
  if (preventInline || typed.length < MIN_TYPED || /[\s/:?#@]/.test(typed)) return "none";
  const bare = bareHost(typed);
  if (!bare || !topHistoryHosts(history).some((host) => host !== bare && host.startsWith(bare))) return "none";
  return completion ? "offered" : "missed";
}
