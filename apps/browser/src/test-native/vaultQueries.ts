import type { VaultItem } from "@ardia/ardiacore";
const isArdiaProvider = (provider: string) => provider === "ardia";
import { rankItems, searchItems, siteKey, siteLabel, TIER } from "../state/vaults/originMatch";
import { previousUsernames } from "../state/vaults/usernames";

export const SITE_ITEMS_CAP = 500;

const withScheme = (url: string) => (!url || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
const byText = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const forProfile = (items: readonly VaultItem[], profile: string | null | undefined) =>
  profile === undefined ? items : items.filter((i) => !isArdiaProvider(i.provider) || (typeof profile === "string" && i.profile === profile));

export function fakeSiteItems(items: readonly VaultItem[], origin: string): VaultItem[] {
  const page = siteKey(origin);
  if (!page) return [];
  return items.filter((item) => item.urls.some((url) => siteKey(withScheme(url)) === page)).slice(0, SITE_ITEMS_CAP);
}

export const fakeSearchItems = (items: readonly VaultItem[], query: string, limit: number, profile: string | null | undefined) =>
  searchItems(forProfile(items, profile), query, Math.min(Math.max(limit, 0), 200));

function listedRow(item: VaultItem) {
  const url = withScheme(item.urls[0] ?? "");
  const site = url ? siteLabel(url) : item.title;
  return { item, site, hay: [url || site, item.username, item.title].join(" ").toLowerCase() };
}

export function fakeListItems(items: readonly VaultItem[], args: { query?: string; offset?: number; limit: number; managersOnly?: boolean; profile?: string | null }) {
  const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const pool = forProfile(args.managersOnly ? items.filter((i) => !isArdiaProvider(i.provider)) : items, args.profile);
  const rows = pool
    .map(listedRow)
    .filter((row) => words.every((w) => row.hay.includes(w)))
    .sort((a, b) => byText.compare(a.site, b.site) || byText.compare(a.item.username, b.item.username));
  const offset = Math.max(0, args.offset ?? 0);
  return { total: rows.length, items: rows.slice(offset, offset + Math.min(Math.max(args.limit, 0), 1000)).map((row) => row.item) };
}

type Saved = { origin: string; username: string };

const PANE_PAGE_MOST = 500;

export function fakePaneRows(saved: readonly Saved[], items: readonly VaultItem[], args: { query?: string; offset?: number; limit: number; managers?: boolean }, revision: string) {
  const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const own = saved
    .map((login) => ({ login, site: siteLabel(login.origin) || login.origin, hay: `${login.origin} ${login.username}`.toLowerCase() }))
    .filter((row) => words.every((w) => row.hay.includes(w)))
    .map((row) => ({ site: row.site, username: row.login.username, row: { saved: { ...row.login, created: 0, modified: 0 } } }));
  const managers = args.managers
    ? fakeListItems(items, { query: args.query, offset: 0, limit: 1000, managersOnly: true }).items.map((item) => ({ ...listedRow(item), row: { item } }))
    : [];
  const all = [...own, ...managers.map((m) => ({ site: m.site, username: m.item.username, row: m.row }))].sort((a, b) => byText.compare(a.site, b.site) || byText.compare(a.username, b.username));
  const offset = Math.max(0, args.offset ?? 0);
  const listed = saved.length + (args.managers ? items.filter((i) => !isArdiaProvider(i.provider)).length : 0);
  return { total: all.length, listed, offset, rows: all.slice(offset, offset + Math.min(Math.max(args.limit, 0), PANE_PAGE_MOST)).map((r) => r.row), revision };
}

const realmOf = (origin: string) => origin.replace(/\/+$/, "").toLowerCase();

export const fakeSavedOn = (saved: readonly Saved[], origin: string) => saved.filter((s) => realmOf(s.origin) === realmOf(origin)).map((s) => ({ ...s, created: 0, modified: 0 }));

export const fakeUsernames = (items: readonly VaultItem[], email: boolean, limit: number, profile: string | null | undefined) =>
  previousUsernames(forProfile(items, profile), { email, limit: Math.min(Math.max(limit, 0), 50) }).map((u) => u.item);

export function fakeRecommend(items: readonly VaultItem[], origin: string, profile: string | null | undefined, pageUsername: string | null, remembered: string | null): VaultItem[] {
  const ranked = rankItems(forProfile(fakeSiteItems(items, origin), profile), origin, remembered);
  const wanted = pageUsername?.trim().toLowerCase() ?? "";
  const pinned = wanted ? ranked.filter((r) => r.item.username.trim().toLowerCase() === wanted) : [];
  const rest = ranked.filter((r) => !pinned.includes(r));
  return [...pinned, ...rest].map(({ item, tier }) => ({ ...item, match: { tier, reason: tier >= TIER.sameHost ? ("origin" as const) : ("site" as const) } }));
}

