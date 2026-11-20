import type { BrowserState } from "../browser/store";
import type { HistoryEntry, Profile } from "../browser/types";
import type { Download } from "../../platform/downloads";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { searchText } from "../../lib/textSearch";

export type ProfileOwners = ReadonlyMap<string, readonly string[]>;
export type Owned = { owners?: readonly string[] };

type ScopeState = Pick<BrowserState, "profiles" | "profileOrder" | "windows" | "settings">;

export const NO_OWNERS: readonly string[] = [];
const NO_ENTRIES: readonly HistoryEntry[] = [];

export const listedProfiles = (s: Pick<BrowserState, "profiles" | "profileOrder">): string[] => s.profileOrder.filter((id) => !!s.profiles[id] && !isIncognitoProfile(id));

export function libraryMergesProfiles(s: ScopeState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && w.kind !== "private" && s.settings.sidebarLibraryAllProfiles && listedProfiles(s).length > 1;
}

export const libraryProfileFilterOf = (s: ScopeState, windowId: string, chosen: string | null | undefined): string | null =>
  chosen && libraryMergesProfiles(s, windowId) && listedProfiles(s).includes(chosen) ? chosen : null;

export function profileOwners(s: Pick<BrowserState, "profiles" | "profileOrder">): ProfileOwners {
  const owners = new Map<string, string[]>();
  for (const id of listedProfiles(s)) {
    const engine = engineProfile(s, id);
    const list = owners.get(engine);
    if (list) list.push(id);
    else owners.set(engine, [id]);
  }
  return owners;
}

let lastOwners: { profiles: unknown; order: unknown; owners: ProfileOwners } | null = null;

export function sharedProfileOwners(s: Pick<BrowserState, "profiles" | "profileOrder">): ProfileOwners {
  if (lastOwners?.profiles !== s.profiles || lastOwners.order !== s.profileOrder) lastOwners = { profiles: s.profiles, order: s.profileOrder, owners: profileOwners(s) };
  return lastOwners.owners;
}

export const isPrivateDownload = (d: Pick<Download, "profile" | "offTheRecord">): boolean => !!d.offTheRecord || (!!d.profile && isIncognitoProfile(d.profile));

export const downloadOwners = (owners: ProfileOwners, d: Pick<Download, "profile" | "offTheRecord">): readonly string[] | undefined =>
  isPrivateDownload(d) ? undefined : owners.get(d.profile ?? "");

export function ownersOfEngines(owners: ProfileOwners, engines: readonly string[]): readonly string[] {
  if (engines.length === 1) return owners.get(engines[0]!) ?? NO_OWNERS;
  return engines.flatMap((engine) => owners.get(engine) ?? NO_OWNERS);
}

const historyTags = new WeakMap<HistoryEntry, readonly string[]>();
const taggedLists = new WeakMap<readonly HistoryEntry[], string>();

export function tagHistory(list: readonly HistoryEntry[], owners: readonly string[]) {
  const key = owners.join("\n");
  if (taggedLists.get(list) === key) return;
  for (let i = 0; i < list.length; i++) historyTags.set(list[i]!, owners);
  taggedLists.set(list, key);
}

export const historyOwnersOf = (entry: HistoryEntry): readonly string[] | undefined => historyTags.get(entry);

export type HistorySource = { list: readonly HistoryEntry[]; owners: readonly string[] };

export function mergedHistory(sources: readonly HistorySource[]): readonly HistoryEntry[] {
  for (const source of sources) tagHistory(source.list, source.owners);
  const lists = sources.map((source) => source.list).filter((list) => list.length > 0);
  if (!lists.length) return NO_ENTRIES;
  if (lists.length === 1) return lists[0]!;
  let total = 0;
  for (const list of lists) total += list.length;
  const out = new Array<HistoryEntry>(total);
  const heads = lists.map(() => 0);
  for (let n = 0; n < total; n++) {
    let best = -1;
    let bestAt = -Infinity;
    for (let k = 0; k < lists.length; k++) {
      const entry = lists[k]![heads[k]!];
      if (entry && (best < 0 || entry.lastVisit > bestAt)) {
        best = k;
        bestAt = entry.lastVisit;
      }
    }
    out[n] = lists[best]![heads[best]!++]!;
  }
  return out;
}

export function engineHistories(owners: ProfileOwners, history: BrowserState["history"], only: string | null, s: Pick<BrowserState, "profiles">): HistorySource[] {
  if (only !== null) {
    const engine = engineProfile(s, only);
    const shared = owners.get(engine) ?? [only];
    return [{ list: shared.length === 1 ? (history[engine]?.list ?? NO_ENTRIES) : NO_ENTRIES, owners: shared }];
  }
  return [...owners].map(([engine, ids]) => ({ list: history[engine]?.list ?? NO_ENTRIES, owners: ids }));
}

const scopedHistories = new WeakMap<ProfileOwners, WeakMap<BrowserState["history"], Map<string, readonly HistoryEntry[]>>>();

export function scopedHistory(owners: ProfileOwners, history: BrowserState["history"], only: string | null, s: Pick<BrowserState, "profiles">): readonly HistoryEntry[] {
  let byHistory = scopedHistories.get(owners);
  if (!byHistory) scopedHistories.set(owners, (byHistory = new WeakMap()));
  let byFilter = byHistory.get(history);
  if (!byFilter) byHistory.set(history, (byFilter = new Map()));
  const key = only ?? "";
  let list = byFilter.get(key);
  if (!list) byFilter.set(key, (list = mergedHistory(engineHistories(owners, history, only, s))));
  return list;
}

export const itemOwners = (item: object): readonly string[] | undefined =>
  "owners" in item ? (item as Owned).owners : "lastVisit" in item ? historyOwnersOf(item as HistoryEntry) : undefined;

export const ownedBy = (item: object, profileId: string): boolean => {
  const owners = itemOwners(item);
  return owners?.length === 1 && owners[0] === profileId;
};

export function withinProfile<T extends object>(items: readonly T[], profileId: string | null): readonly T[] {
  if (profileId === null) return items;
  return items.filter((item) => ownedBy(item, profileId));
}

const ownerTexts = new WeakMap<readonly string[], { profiles: Readonly<Record<string, Profile>>; text: string }>();

export function ownerSearchText(owners: readonly string[] | undefined, profiles: Readonly<Record<string, Profile>>): string {
  if (!owners?.length) return "";
  const kept = ownerTexts.get(owners);
  if (kept?.profiles === profiles) return kept.text;
  const text = searchText(...owners.map((id) => profiles[id]?.name ?? ""));
  ownerTexts.set(owners, { profiles, text });
  return text;
}

const profileSearches = new WeakMap<Readonly<Record<string, Profile>>, (item: object) => string>();

export function profileSearchOf(profiles: Readonly<Record<string, Profile>>): (item: object) => string {
  let search = profileSearches.get(profiles);
  if (!search) profileSearches.set(profiles, (search = (item: object) => ownerSearchText(itemOwners(item), profiles)));
  return search;
}

const VISIT_KEY = "\n";

export function visitKeyOf(entry: Pick<HistoryEntry, "url">): string {
  const owner = historyOwnersOf(entry as HistoryEntry)?.[0];
  return owner === undefined ? entry.url : `${owner}${VISIT_KEY}${entry.url}`;
}

export function parseVisitKey(key: string): { profileId: string | null; url: string } {
  const at = key.indexOf(VISIT_KEY);
  return at < 0 ? { profileId: null, url: key } : { profileId: key.slice(0, at), url: key.slice(at + 1) };
}

export function profileNamesOf(owners: readonly string[] | undefined, profiles: Readonly<Record<string, Profile>>): string {
  return (owners ?? NO_OWNERS).map((id) => profiles[id]?.name).filter((name): name is string => !!name).join(", ");
}

const ownerNames = new WeakMap<readonly string[], { profiles: Readonly<Record<string, Profile>>; names: string }>();

export function ownerNamesOf(owners: readonly string[] | undefined, profiles: Readonly<Record<string, Profile>>): string {
  if (!owners?.length) return "";
  const kept = ownerNames.get(owners);
  if (kept?.profiles === profiles) return kept.names;
  const names = profileNamesOf(owners, profiles);
  ownerNames.set(owners, { profiles, names });
  return names;
}

export const soleOwner = (owners: readonly string[] | undefined): string | undefined => (owners?.length === 1 ? owners[0] : undefined);

export const actingOwner = (owners: readonly string[] | undefined, current: string): string | undefined =>
  !owners?.length ? undefined : owners.includes(current) ? current : owners[0];
