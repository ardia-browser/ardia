import { dedupeSuggestions, type RemoteSite } from "@ardia/core";

export type Remote = { text: string; engine: string; list: string[]; sites: RemoteSite[]; gaveUp?: string };

const NO_REMOTE: string[] = [];
const NO_SITES: RemoteSite[] = [];
const SHOWN_QUERIES = 4;
const SHOWN_SITES = 2;

const carries = (remote: Remote, q: string, engine: string) => remote.engine === engine && !!remote.text && q.startsWith(remote.text.toLowerCase());

export const askedKey = (engine: string, query: string, attempt: number) => `${attempt}\n${engine}\n${query}`;

export function remoteListFor(remote: Remote, query: string, engine: string): string[] {
  if (remote.text === query && remote.engine === engine) return remote.list;
  const q = query.toLowerCase();
  return carries(remote, q, engine) ? remote.list.filter((s) => s.toLowerCase().startsWith(q)) : NO_REMOTE;
}

export function remoteSitesFor(remote: Remote, query: string, engine: string): RemoteSite[] {
  if (remote.text === query && remote.engine === engine) return remote.sites;
  const q = query.toLowerCase();
  if (!carries(remote, q, engine)) return NO_SITES;
  return remote.sites.filter((site) => site.title.toLowerCase().startsWith(q) || site.url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase().startsWith(q));
}

const shownQueries = (list: readonly string[], query: string) => dedupeSuggestions(list, query.replace(/^\?/, "").trim()).slice(0, SHOWN_QUERIES);

export function answered(remote: Remote, query: string, engine: string, list: string[], sites: RemoteSite[], attempt: string): Remote {
  if (remote.gaveUp === attempt) return remote;
  const carried = remoteListFor(remote, query, engine);
  const carriedSites = remoteSitesFor(remote, query, engine).slice(0, SHOWN_SITES);
  const queriesShown = shownQueries(carried, query).length > 0;
  if (!queriesShown && !carriedSites.length) return { text: query, engine, list, sites };
  const added = sites.filter((site) => !carriedSites.some((shown) => shown.url === site.url));
  return { text: query, engine, list: [...carried, ...list.filter((s) => !carried.includes(s))], sites: queriesShown ? carriedSites : [...carriedSites, ...added] };
}

export function addsRows(before: Remote, after: Remote, query: string, engine: string, sitesShown: boolean): boolean {
  if (after === before) return false;
  const queries = (list: readonly string[]) => shownQueries(list, query).length;
  const sites = (list: readonly RemoteSite[]) => (sitesShown && !query.startsWith("?") ? Math.min(list.length, SHOWN_SITES) : 0);
  return queries(after.list) > queries(remoteListFor(before, query, engine)) || sites(after.sites) > sites(remoteSitesFor(before, query, engine));
}
