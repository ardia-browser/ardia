import { consentToken, type ConsentToken } from "../telemetry/choice";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { onAppEvent } from "../../platform/app";
import { openUrlFromSettings } from "../settings/settingsWindows";
import { useEffect } from "react";
import { onVaultApproval, onVaultChanged, onVaultItemsChanged, searchVaultItems, vaultBiometrics, vaultItemsStatus, vaultProviders, vaultSiteItems, type VaultItem, type VaultProviderState } from "../../platform/vaults";
import { isArdiaProvider } from "./ardia";
import { credential, titleOf } from "./providerModel";
import { vaultsOnForProfile } from "./enabled";
import { clearVaultCodes } from "./codes";
import { forgetRememberedVaultAccount, rememberedVaultLogin } from "./accounts";
import { forgetPending, type PendingTotp } from "./pendingTotp";
import { itemKey, siteKey } from "./originMatch";
import { activeTabId } from "../browser/model";
import type { BrowserState } from "../browser/store";
import { noteCredentialProvidersConnected, noteStaleVaultProviderState } from "../telemetry/vaultCounts";

type VaultsState = {
  providers: VaultProviderState[];
  sites: Readonly<Record<string, readonly VaultItem[]>>;
  searches: Readonly<Record<string, readonly VaultItem[]>>;
  listed: readonly string[];
  itemsStamp: number;
  pending: PendingTotp[];
  revision: number;
};

export const NO_ITEMS: readonly VaultItem[] = [];

export const useVaults = create<VaultsState>()(() => ({ providers: [], sites: {}, searches: {}, listed: [], itemsStamp: 0, pending: [], revision: 0 }));

const SITES_KEPT = 32;
export const SITE_ITEMS_CAP = 500;
const RECENT_SITE_MS = 120_000;
const SEARCH_ROWS_MOST = 200;

type SiteMeta = { origin: string; usedAt: number; stale: boolean };
const siteMeta = new Map<string, SiteMeta>();
const siteLoads = new Map<string, Promise<readonly VaultItem[]>>();
let itemsGeneration = 0;
let stateStamp = 0;
const stateChangedAt = new Map<string, number>();

const vaults = () => useVaults.getState();
export const changeVaults = (patch: (s: VaultsState) => Partial<VaultsState>) => useVaults.setState((s) => ({ ...patch(s), revision: s.revision + 1 }));

export const isConnected = (p: Pick<VaultProviderState, "state">) => p.state === "unlocked" || p.state === "locked";
export const currentVaultProviders = () => vaults().providers;
export const vaultProviderOf = (id: string) => vaults().providers.find((p) => p.id === id);
const nameOf = (p: VaultProviderState) => titleOf(credential(p));
const byBrandOrder = (list: readonly VaultProviderState[]) =>
  [...list].sort((a, b) => Number(isArdiaProvider(b.id)) - Number(isArdiaProvider(a.id)) || nameOf(a).localeCompare(nameOf(b)));

export const vaultManagerName = (id: string) => {
  const p = vaultProviderOf(id);
  return p ? nameOf(p) : isArdiaProvider(id) ? "Ardia" : "Password Manager";
};
export const anyVaultConnected = (profileId: string) => vaultsOnForProfile(profileId) && vaults().providers.some(isConnected);
export function anyVaultConnectedForTab(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  return !!tab && anyVaultConnected(tab.profileId);
}
export const vaultRevision = () => vaults().revision;
export const currentPendingTotp = () => vaults().pending;
export const setPendingTotp = (pending: PendingTotp[]) => changeVaults(() => ({ pending }));

export const vaultSiteKey = (origin: string) => siteKey(origin) || origin;

export const unlockedIdsOf = (providers: readonly VaultProviderState[]) => new Set(providers.filter((p) => p.state === "unlocked").map((p) => p.id));

export const isVaultListed = (s: Pick<VaultsState, "providers" | "listed">, id: string) =>
  s.listed.includes(id) && s.providers.some((p) => p.id === id && p.state === "unlocked");

export function siteItemsOf(s: Pick<VaultsState, "providers" | "sites">, origin: string): readonly VaultItem[] {
  const cached = s.sites[vaultSiteKey(origin)];
  if (!cached?.length) return NO_ITEMS;
  const unlocked = unlockedIdsOf(s.providers);
  return cached.every((item) => unlocked.has(item.provider)) ? cached : cached.filter((item) => unlocked.has(item.provider));
}

export function siteItemsNow(origin: string): readonly VaultItem[] {
  const key = vaultSiteKey(origin);
  if (!key) return NO_ITEMS;
  const meta = siteMeta.get(key);
  if (meta) meta.usedAt = Date.now();
  if (!meta || meta.stale) void loadSiteItems(origin);
  return siteItemsOf(vaults(), origin);
}

function keepSite(key: string, origin: string) {
  const usedAt = siteMeta.get(key)?.usedAt ?? Date.now();
  siteMeta.delete(key);
  siteMeta.set(key, { origin, usedAt, stale: false });
  const dropped: string[] = [];
  while (siteMeta.size > SITES_KEPT) {
    const oldest = siteMeta.keys().next().value!;
    siteMeta.delete(oldest);
    dropped.push(oldest);
  }
  return dropped;
}

type Missing = { provider: string; id: string; username: string };

async function confirmedMissing(candidates: readonly Missing[]): Promise<Set<string>> {
  const gone = new Set<string>();
  if (!candidates.length) return gone;
  const status = await vaultItemsStatus().catch(() => null);
  if (!status) return gone;
  for (const candidate of candidates) {
    if (!candidate.username || !status.listed.includes(candidate.provider) || !((status.counts[candidate.provider] ?? 0) > 0)) continue;
    const found = await searchVaultItems(candidate.username, SEARCH_ROWS_MOST, null).catch(() => null);
    if (!found || found.length >= SEARCH_ROWS_MOST || found.some((item) => itemKey(item) === itemKey(candidate))) continue;
    gone.add(itemKey(candidate));
  }
  return gone;
}

async function pruneMissingOnSite(origin: string, key: string, items: readonly VaultItem[], consent: ConsentToken | null) {
  if (items.length >= SITE_ITEMS_CAP) return;
  const present = new Set(items.map(itemKey));
  const remembered = rememberedVaultLogin(origin);
  const pending = vaults().pending.filter((p) => vaultSiteKey(p.origin) === key && !present.has(itemKey(p)));
  const candidates: Missing[] = pending.map((p) => ({ provider: p.provider, id: p.id, username: p.username ?? "" }));
  if (remembered && !present.has(remembered.key)) {
    const slash = remembered.key.indexOf("/");
    candidates.push({ provider: remembered.key.slice(0, slash), id: remembered.key.slice(slash + 1), username: remembered.username ?? "" });
  }
  const gone = await confirmedMissing(candidates);
  if (!gone.size) return;
  if (remembered && gone.has(remembered.key)) forgetRememberedVaultAccount(origin, remembered.key, consent);
  changeVaults((s) => ({ pending: s.pending.filter((p) => vaultSiteKey(p.origin) !== key || !gone.has(itemKey(p))) }));
}

export function loadSiteItems(origin: string): Promise<readonly VaultItem[]> {
  const key = vaultSiteKey(origin);
  if (!key || preview) return Promise.resolve(NO_ITEMS);
  const running = siteLoads.get(key);
  if (running) return running;
  const consent = consentToken();
  const asked = itemsGeneration;
  const answered = vaultSiteItems(origin).then(
    ({ items, listed }): readonly VaultItem[] | null => {
      if (asked !== itemsGeneration) return null;
      const dropped = keepSite(key, origin);
      const unlocked = unlockedIdsOf(vaults().providers);
      const kept = items.filter((item) => unlocked.has(item.provider));
      changeVaults((s) => {
        const sites: Record<string, readonly VaultItem[]> = { ...s.sites, [key]: kept };
        for (const gone of dropped) delete sites[gone];
        return { sites, listed: listed.filter((id) => unlocked.has(id)) };
      });
      return kept;
    },
    (): readonly VaultItem[] => NO_ITEMS,
  );
  const settled: Promise<readonly VaultItem[]> = answered.then(async (items) => {
    if (items !== null && items !== NO_ITEMS) await pruneMissingOnSite(origin, key, items, consent).catch(() => undefined);
    if (siteLoads.get(key) === settled) siteLoads.delete(key);
    return items === null ? loadSiteItems(origin) : items;
  });
  siteLoads.set(key, settled);
  return settled;
}

export function useVaultSiteItems(origin: string | null): readonly VaultItem[] {
  const items = useVaults((s) => (origin ? siteItemsOf(s, origin) : NO_ITEMS));
  const revision = useVaults((s) => s.revision);
  useEffect(() => {
    if (origin) siteItemsNow(origin);
  }, [origin, revision]);
  return items;
}

let preview = false;

export function showPreviewProviders(providers: VaultProviderState[] | null) {
  preview = providers !== null;
  changeVaults(() => ({ providers: byBrandOrder(providers ?? []) }));
  if (!preview) void loadVaultProviders();
}

export const showingPreviewProviders = () => preview;

function dropProviderItems(s: VaultsState, provider: string): Partial<VaultsState> {
  clearVaultCodes();
  const listed = s.listed.includes(provider) ? s.listed.filter((id) => id !== provider) : s.listed;
  const sites: Record<string, readonly VaultItem[]> = {};
  let changed = false;
  for (const [key, items] of Object.entries(s.sites)) {
    const kept = items.some((item) => item.provider === provider) ? items.filter((item) => item.provider !== provider) : items;
    changed ||= kept !== items;
    sites[key] = kept;
  }
  const searches = Object.values(s.searches).some((items) => items.some((item) => item.provider === provider)) ? {} : s.searches;
  return { listed, sites: changed ? sites : s.sites, searches, pending: forgetPending(s.pending, provider) };
}

function removeProvider(id: string) {
  stateChangedAt.set(id, ++stateStamp);
  changeVaults((s) => ({ providers: s.providers.filter((p) => p.id !== id), ...dropProviderItems(s, id) }));
}

export function applyProviderState(state: VaultProviderState, removed = false) {
  if (preview) return;
  if (removed) return removeProvider(state.id);
  const before = vaultProviderOf(state.id);
  stateChangedAt.set(state.id, ++stateStamp);
  changeVaults((s) => {
    const others = s.providers.filter((p) => p.id !== state.id);
    const providers = byBrandOrder([...others, state]);
    return state.state === "unlocked" ? { providers } : { providers, ...dropProviderItems(s, state.id) };
  });
  if (state.state === "unlocked" && before?.state !== "unlocked") void loadVaultItems(state.id, true);
}

export function clearVaultIndex() {
  itemsGeneration++;
  siteMeta.clear();
  siteLoads.clear();
  clearVaultCodes();
  changeVaults((s) => ({ sites: {}, searches: {}, listed: [], pending: [], itemsStamp: s.itemsStamp + 1 }));
}

const changedSince = (provider: string, stamp: number) => (stateChangedAt.get(provider) ?? 0) > stamp;

export const loadVaultProviders = () => runLoadVaultProviders(consentToken());

async function runLoadVaultProviders(consent: ConsentToken | null) {
  if (preview) return;
  const asked = stateStamp;
  let listed: VaultProviderState[];
  try {
    listed = await vaultProviders();
  } catch {
    return;
  }
  if (preview) return;
  const wasUnlocked = unlockedIdsOf(vaults().providers);
  changeVaults((s) => {
    const providers = byBrandOrder(
      listed.map((p) => {
        if (!changedSince(p.id, asked)) return p;
        noteStaleVaultProviderState(consent);
        return s.providers.find((now) => now.id === p.id) ?? p;
      }),
    );
    const unlocked = unlockedIdsOf(providers);
    let next: Partial<VaultsState> = {};
    for (const provider of s.listed) if (!unlocked.has(provider)) next = { ...next, ...dropProviderItems({ ...s, ...next } as VaultsState, provider) };
    return { providers, ...next };
  });
  if ([...unlockedIdsOf(vaults().providers)].some((id) => !wasUnlocked.has(id)) || !vaults().listed.length) void refreshVaultItems();
}

function invalidateItems() {
  itemsGeneration++;
  siteLoads.clear();
  for (const meta of siteMeta.values()) meta.stale = true;
  changeVaults((s) => ({ searches: {}, itemsStamp: s.itemsStamp + 1 }));
}

async function refreshVaultItems(): Promise<void> {
  if (preview) return;
  invalidateItems();
  const now = Date.now();
  const recent = [...siteMeta.values()].filter((m) => now - m.usedAt < RECENT_SITE_MS).map((m) => m.origin);
  const status = vaultItemsStatus().then(
    ({ listed }) => changeVaults((s) => ({ listed: listed.filter((id) => unlockedIdsOf(s.providers).has(id)) })),
    () => undefined,
  );
  await Promise.all([status, ...recent.map((origin) => loadSiteItems(origin))]);
}

export function loadVaultItems(provider: string, force = false): Promise<void> {
  if (!force && vaults().listed.includes(provider)) return Promise.resolve();
  return refreshVaultItems();
}

export const loadAllVaultItems = (force = false) => (force || !vaults().listed.length ? refreshVaultItems() : Promise.resolve());

export const loadManagerItems = () => loadAllVaultItems(false);

export const useVaultBiometrics = create<{ available: boolean }>()(() => ({ available: false }));

export function refreshVaultBiometrics() {
  void vaultBiometrics().then(
    (available) => useVaultBiometrics.setState({ available }),
    () => useVaultBiometrics.setState({ available: false }),
  );
}

function frontOriginOf(s: BrowserState): string | null {
  const windowId = s.ui.focusOrder.find((id) => !!s.windows[id]);
  const tabId = windowId ? activeTabId(s, windowId) : undefined;
  const url = tabId ? s.tabs[tabId]?.url : undefined;
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

let started = false;

export function startVaultIndex() {
  if (started) return;
  started = true;
  useVaults.subscribe((s, prev) => {
    if (s.providers === prev.providers) return;
    noteCredentialProvidersConnected(s.providers.filter((p) => !!credential(p).plugin && (p.state === "unlocked" || p.state === "locked")).map((p) => p.id));
  });
  onVaultChanged(applyProviderState);
  onVaultApproval((_, url) => openUrlFromSettings(url));
  onVaultItemsChanged(() => void refreshVaultItems());
  useBrowser.subscribeTo(["tabs", "windows", "ui"], (b, prev) => {
    if (b.tabs === prev.tabs && b.windows === prev.windows && b.ui === prev.ui) return;
    const front = frontOriginOf(b);
    if (front && front !== frontOriginOf(prev) && vaults().providers.some((p) => p.state === "unlocked")) void loadSiteItems(front);
  });
  onAppEvent((e) => e.type === "lockedOrAsleep" && clearVaultIndex());
  void loadVaultProviders();
}
