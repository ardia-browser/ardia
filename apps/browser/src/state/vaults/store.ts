import { consentToken, type ConsentToken } from "../telemetry/choice";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { onAppEvent } from "../../platform/app";
import { openUrlFromSettings } from "../settings/settingsWindows";
import { onVaultApproval, onVaultChanged, onVaultItemsChanged, vaultBiometrics, vaultItems, vaultProviders, type VaultItem, type VaultProviderState } from "../../platform/vaults";
import { isArdiaProvider } from "./ardia";
import { credential, titleOf } from "./providerModel";
import { vaultsOnForProfile } from "./enabled";
import { clearVaultCodes } from "./codes";
import { forgetMissingVaultAccounts } from "./accounts";
import { forgetPending, keepListedPending, type PendingTotp } from "./pendingTotp";
import { noteCredentialProvidersConnected, noteStaleVaultProviderState } from "../telemetry/vaultCounts";

type VaultsState = {
  providers: VaultProviderState[];
  items: Record<string, VaultItem[]>;
  pending: PendingTotp[];
  revision: number;
};

export const useVaults = create<VaultsState>()(() => ({ providers: [], items: {}, pending: [], revision: 0 }));

const ITEMS_FRESH_MS = 30_000;
const fetchedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
const queued = new Map<string, Promise<void>>();
const generation = new Map<string, number>();
const generationOf = (provider: string) => generation.get(provider) ?? 0;
let stateStamp = 0;
const stateChangedAt = new Map<string, number>();

const vaults = () => useVaults.getState();
const change = (patch: (s: VaultsState) => Partial<VaultsState>) => useVaults.setState((s) => ({ ...patch(s), revision: s.revision + 1 }));

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
export const allVaultItems = (): VaultItem[] => Object.values(vaults().items).flat();
export const vaultRevision = () => vaults().revision;
export const currentPendingTotp = () => vaults().pending;
export const setPendingTotp = (pending: PendingTotp[]) => change(() => ({ pending }));

function dropItems(s: VaultsState, provider: string) {
  fetchedAt.delete(provider);
  generation.set(provider, generationOf(provider) + 1);
  clearVaultCodes();
  if (!(provider in s.items)) return { items: s.items, pending: forgetPending(s.pending, provider) };
  const { [provider]: _gone, ...items } = s.items;
  return { items, pending: forgetPending(s.pending, provider) };
}

let preview = false;

export function showPreviewProviders(providers: VaultProviderState[] | null) {
  preview = providers !== null;
  change(() => ({ providers: byBrandOrder(providers ?? []) }));
  if (!preview) void loadVaultProviders();
}

export const showingPreviewProviders = () => preview;

function removeProvider(id: string) {
  stateChangedAt.set(id, ++stateStamp);
  change((s) => ({ providers: s.providers.filter((p) => p.id !== id), ...dropItems(s, id) }));
}

export function applyProviderState(state: VaultProviderState, removed = false) {
  if (preview) return;
  if (removed) return removeProvider(state.id);
  const before = vaultProviderOf(state.id);
  stateChangedAt.set(state.id, ++stateStamp);
  change((s) => {
    const others = s.providers.filter((p) => p.id !== state.id);
    const providers = byBrandOrder([...others, state]);
    return state.state === "unlocked" ? { providers } : { providers, ...dropItems(s, state.id) };
  });
  if (state.state === "unlocked" && before?.state !== "unlocked") void loadVaultItems(state.id, true);
}

export function clearVaultIndex() {
  fetchedAt.clear();
  for (const provider of new Set([...generation.keys(), ...inFlight.keys()])) generation.set(provider, generationOf(provider) + 1);
  clearVaultCodes();
  change(() => ({ items: {}, pending: [] }));
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
  change((s) => {
    const providers = byBrandOrder(
      listed.map((p) => {
        if (!changedSince(p.id, asked)) return p;
        noteStaleVaultProviderState(consent);
        return s.providers.find((now) => now.id === p.id) ?? p;
      }),
    );
    const unlocked = new Set(providers.filter((p) => p.state === "unlocked").map((p) => p.id));
    let next: Pick<VaultsState, "items" | "pending"> = { items: s.items, pending: s.pending };
    for (const provider of Object.keys(s.items)) if (!unlocked.has(provider)) next = dropItems({ ...s, ...next }, provider);
    return { providers, ...next };
  });
  for (const p of currentVaultProviders()) if (p.state === "unlocked") void loadVaultItems(p.id);
}

async function fetchItems(provider: string) {
  const consent = consentToken();
  const asked = generationOf(provider);
  try {
    const items = await vaultItems(provider);
    if (vaultProviderOf(provider)?.state !== "unlocked" || generationOf(provider) !== asked) return;
    fetchedAt.set(provider, Date.now());
    const listed = items.filter((i) => i.provider === provider);
    const ids = new Set(listed.map((i) => i.id));
    const prune = listed.length > 0;
    change((s) => ({ items: { ...s.items, [provider]: listed }, pending: prune ? keepListedPending(s.pending, provider, ids) : s.pending }));
    if (prune) forgetMissingVaultAccounts(provider, ids, consent);
  } catch {
    fetchedAt.delete(provider);
  }
}

export function loadVaultItems(provider: string, force = false): Promise<void> {
  if (vaultProviderOf(provider)?.state !== "unlocked") return Promise.resolve();
  if (!force && Date.now() - (fetchedAt.get(provider) ?? 0) < ITEMS_FRESH_MS) return Promise.resolve();
  const running = inFlight.get(provider);
  if (running && !force) return running;
  if (running) return queued.get(provider) ?? queueAfter(provider, running);
  const run = fetchItems(provider).finally(() => inFlight.delete(provider));
  inFlight.set(provider, run);
  return run;
}

function queueAfter(provider: string, running: Promise<void>) {
  const next = running.then(() => {
    queued.delete(provider);
    return loadVaultItems(provider, true);
  });
  queued.set(provider, next);
  return next;
}

export const loadAllVaultItems = (force = false) => loadItemsOf(vaults().providers, force);

export const loadManagerItems = () => loadItemsOf(vaults().providers.filter((p) => !isArdiaProvider(p.id)), false);

function loadItemsOf(providers: readonly VaultProviderState[], force: boolean) {
  return Promise.all(providers.filter((p) => p.state === "unlocked").map((p) => loadVaultItems(p.id, force))).then(() => undefined);
}

export const useVaultBiometrics = create<{ available: boolean }>()(() => ({ available: false }));

export function refreshVaultBiometrics() {
  void vaultBiometrics().then(
    (available) => useVaultBiometrics.setState({ available }),
    () => useVaultBiometrics.setState({ available: false }),
  );
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
  onVaultItemsChanged((provider) => void loadVaultItems(provider, true));
  onAppEvent((e) => e.type === "lockedOrAsleep" && clearVaultIndex());
  void loadVaultProviders();
}
