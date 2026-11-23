import type { VaultItem } from "@ardia/ardiacore";
const isArdiaProvider = (provider: string) => provider === "ardia";
import { searchItems, siteKey, siteLabel } from "../state/vaults/originMatch";
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

export const fakeUsernames = (items: readonly VaultItem[], email: boolean, limit: number, profile: string | null | undefined) =>
  previousUsernames(forProfile(items, profile), { email, limit: Math.min(Math.max(limit, 0), 50) }).map((u) => u.item);
