import { matchesQuery } from "../pages/PageLayout";

export type ShortcutSearchHit = "named" | "keyword" | null;

export function shortcutSearchHit(query: string, named: readonly string[], keywords: readonly string[]): ShortcutSearchHit {
  if (matchesQuery(query, ...named)) return "named";
  return keywords.length && matchesQuery(query, ...named, ...keywords) ? "keyword" : null;
}
