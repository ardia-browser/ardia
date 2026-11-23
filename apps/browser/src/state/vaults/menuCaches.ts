import { recommendVaultItems, searchVaultItems, searchVaultItemsOn, vaultUsernames, type VaultItem } from "../../platform/vaults";
import { changeVaults, loadSiteItems, NO_ITEMS, showingPreviewProviders, unlockedIdsOf, useVaults, vaultSiteKey } from "./store";

export const SEARCH_ROWS_ASKED = 100;
const SEARCHES_KEPT = 8;
const MENU_USERNAMES_ASKED = 50;

type Loading = { stamp: number; promise: Promise<readonly VaultItem[]> };

const vaults = () => useVaults.getState();
const searchKeyOf = (query: string, profile: string | null) => `${profile ?? ""}\n${query}`;
const searchLoads = new Map<string, Loading>();
let lastSearch: readonly VaultItem[] = NO_ITEMS;

export function searchResultsNow(query: string, profile: string | null): readonly VaultItem[] {
  const key = searchKeyOf(query, profile);
  const found = vaults().searches[key];
  if (found) return (lastSearch = found);
  void loadSearch(query, profile);
  return lastSearch;
}

export function loadSearch(query: string, profile: string | null): Promise<readonly VaultItem[]> {
  const key = searchKeyOf(query, profile);
  if (showingPreviewProviders()) return Promise.resolve(NO_ITEMS);
  const stamp = vaults().itemsStamp;
  const running = searchLoads.get(key);
  if (running?.stamp === stamp) return running.promise;
  const promise = searchVaultItems(query, SEARCH_ROWS_ASKED, profile).then(
    (items) => {
      if (searchLoads.get(key)?.promise === promise) searchLoads.delete(key);
      const unlocked = unlockedIdsOf(vaults().providers);
      const kept = items.filter((item) => unlocked.has(item.provider));
      if (vaults().itemsStamp !== stamp) return kept;
      changeVaults((s) => {
        const searches: Record<string, readonly VaultItem[]> = { [key]: kept };
        for (const [k, v] of Object.entries(s.searches).slice(0, SEARCHES_KEPT - 1)) if (k !== key) searches[k] = v;
        return { searches };
      });
      return kept;
    },
    () => {
      if (searchLoads.get(key)?.promise === promise) searchLoads.delete(key);
      return NO_ITEMS;
    },
  );
  searchLoads.set(key, { stamp, promise });
  return promise;
}

export async function rankedVaultUsernames(email: boolean, limit: number, profile: string | null): Promise<VaultItem[]> {
  if (showingPreviewProviders()) return [];
  return vaultUsernames(email, limit, profile).catch(() => []);
}

const usernameKeyOf = (email: boolean, profile: string | null) => `${email}\n${profile ?? ""}`;
const usernameLists = new Map<string, Loading & { items: readonly VaultItem[] | null }>();

export function loadMenuUsernames(email: boolean, profile: string | null): Promise<readonly VaultItem[]> {
  const key = usernameKeyOf(email, profile);
  const stamp = vaults().itemsStamp;
  const known = usernameLists.get(key);
  if (known?.stamp === stamp) return known.promise;
  const promise = rankedVaultUsernames(email, MENU_USERNAMES_ASKED, profile).then((items) => {
    if (vaults().itemsStamp !== stamp || usernameLists.get(key)?.promise !== promise) return items;
    usernameLists.set(key, { stamp, items, promise });
    changeVaults(() => ({}));
    return items;
  });
  usernameLists.set(key, { stamp, items: known?.items ?? null, promise });
  return promise;
}

export function menuUsernamesNow(email: boolean, profile: string | null): readonly VaultItem[] {
  const known = usernameLists.get(usernameKeyOf(email, profile));
  if (known?.stamp !== vaults().itemsStamp) void loadMenuUsernames(email, profile);
  return known?.items ?? NO_ITEMS;
}

export const loadMenuItems = (origin: string, usernames: { email: boolean; profile: string | null } | null) =>
  Promise.all([loadSiteItems(origin), usernames ? loadMenuUsernames(usernames.email, usernames.profile) : null]);

export const TYPED_ROWS_ASKED = 20;

type Recommended = { basis: unknown[]; items: readonly VaultItem[] | null; promise: Promise<readonly VaultItem[]> };
const recommendations = new Map<string, Recommended>();
const RECOMMENDATIONS_KEPT = 16;
const recommendKeyOf = (origin: string, profile: string | null, pageUsername: string | null, remembered: string | null) =>
  `${origin}\n${profile ?? ""}\n${pageUsername ?? ""}\n${remembered ?? ""}`;

export function loadRecommended(origin: string, profile: string | null, pageUsername: string | null, remembered: string | null): Promise<readonly VaultItem[]> {
  if (showingPreviewProviders()) return Promise.resolve(NO_ITEMS);
  const key = recommendKeyOf(origin, profile, pageUsername, remembered);
  const basis = basisOf(origin);
  const known = recommendations.get(key);
  if (known && sameBasis(known.basis, basis)) return known.promise;
  const promise = recommendVaultItems(origin, profile, pageUsername, remembered).then(
    ({ items }) => {
      const unlocked = unlockedIdsOf(vaults().providers);
      const kept = items.filter((item) => unlocked.has(item.provider));
      if (!sameBasis(basisOf(origin), basis) || recommendations.get(key)?.promise !== promise) return kept;
      recommendations.delete(key);
      recommendations.set(key, { basis, items: kept, promise });
      while (recommendations.size > RECOMMENDATIONS_KEPT) recommendations.delete(recommendations.keys().next().value!);
      changeVaults(() => ({}));
      return kept;
    },
    () => NO_ITEMS,
  );
  recommendations.set(key, { basis, items: null, promise });
  return promise;
}

const basisOf = (origin: string): unknown[] => {
  const s = vaults();
  return [s.itemsStamp, s.providers, s.listed, s.sites[vaultSiteKey(origin)]];
};
const sameBasis = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function recommendedNow(origin: string, profile: string | null, pageUsername: string | null, remembered: string | null): readonly VaultItem[] | null {
  const known = recommendations.get(recommendKeyOf(origin, profile, pageUsername, remembered));
  if (!known || !sameBasis(known.basis, basisOf(origin))) {
    void loadRecommended(origin, profile, pageUsername, remembered);
    return null;
  }
  return known.items;
}

type Typed = { query: string; stamp: number; items: readonly VaultItem[] };
const typedShown = new Map<string, Typed>();
const typedAsked = new Map<string, string>();

export function typedResultsNow(channel: string, query: string, origin: string, profile: string | null): readonly VaultItem[] | null {
  const shown = typedShown.get(channel);
  const stamp = vaults().itemsStamp;
  if (shown?.query === query && shown.stamp === stamp) return shown.items;
  const key = `${query}\n${origin}\n${profile ?? ""}\n${stamp}`;
  if (typedAsked.get(channel) !== key) {
    typedAsked.set(channel, key);
    void searchVaultItemsOn(query, TYPED_ROWS_ASKED, profile, origin, channel).then(
      (found) => {
        if (found.cancelled || typedAsked.get(channel) !== key) return;
        const unlocked = unlockedIdsOf(vaults().providers);
        typedShown.set(channel, { query, stamp, items: found.items.filter((item) => unlocked.has(item.provider)) });
        changeVaults(() => ({}));
      },
      () => {},
    );
  }
  return shown ? shown.items : null;
}

export function forgetTyped(channel: string) {
  typedShown.delete(channel);
  typedAsked.delete(channel);
}
