import { consentToken } from "../telemetry/choice";
import { create } from "zustand";
import {
  copyGeneratedPassword,
  deleteGeneratedPassword,
  listGeneratedPasswords,
  onGeneratedPasswordsChanged,
  saveGeneratedPassword,
  type VaultGeneratedPassword,
  type VaultGeneratedSaveResult,
  type VaultItem,
  type VaultProviderState,
} from "../../platform/vaults";
import { useBrowser } from "../browser/store";
import { VAULT_KEEP_GENERATED_DAYS } from "../settings/vaultSettings";
import { copyOutcomeOf, type VaultCopyOutcome } from "./actions";
import { rememberVaultAccount } from "./accounts";
import { searchItems, siteLabel } from "./originMatch";
import { ARDIA_PROVIDER, isArdiaProvider } from "./ardia";
import { preferredSaveTarget, saveTargets } from "./saveOffer";
import { loadVaultItems } from "./store";

export type { VaultGeneratedPassword };
type KeepGeneratedDays = (typeof VAULT_KEEP_GENERATED_DAYS)[number];

export const GENERATED_PROVIDER = "generated";
export const DAY_MS = 86_400_000;
export const KEEP_FOREVER = -1;
export const KEEP_NONE = 0;
export const NEEDS_USERNAME = "needsUsername";

const KEEP_TITLES: readonly (readonly [KeepGeneratedDays, string])[] = [
  [1, "1 Day"],
  [7, "7 Days"],
  [30, "30 Days"],
  [KEEP_FOREVER, "Until Deleted"],
  [KEEP_NONE, "Never"],
];

const keepGeneratedTitle = (days: number) => KEEP_TITLES.find(([d]) => d === days)?.[1] ?? `${days} Days`;
export const KEEP_GENERATED_OPTIONS = VAULT_KEEP_GENERATED_DAYS.map((days) => ({ value: String(days), title: keepGeneratedTitle(days) }));

export function isGeneratedExpired(createdAt: number, keepDays: number, now: number): boolean {
  if (keepDays === KEEP_NONE) return true;
  if (keepDays < 0) return false;
  return now - createdAt >= keepDays * DAY_MS;
}

export const keptGenerated = (list: readonly VaultGeneratedPassword[], keepDays: number, now: number): VaultGeneratedPassword[] =>
  list.filter((e) => !isGeneratedExpired(e.createdAt, keepDays, now)).sort((a, b) => b.createdAt - a.createdAt);

const generatedItem = (entry: VaultGeneratedPassword): VaultItem => ({
  provider: GENERATED_PROVIDER,
  id: entry.id,
  title: siteLabel(entry.origin),
  username: entry.username,
  urls: [entry.origin],
  hasTotp: false,
  updatedAt: entry.createdAt,
});

export function searchGenerated(list: readonly VaultGeneratedPassword[], query: string, limit: number): VaultItem[] {
  const items = list.map(generatedItem);
  return query.trim() ? searchItems(items, query, limit) : items.slice(0, limit);
}

export function generatedSaveTargets(providers: readonly VaultProviderState[], chosen = ""): string[] {
  const targets = saveTargets(providers);
  const wanted = preferredSaveTarget(providers, chosen);
  const first = targets.includes(wanted) ? wanted : targets.includes(ARDIA_PROVIDER) ? ARDIA_PROVIDER : targets[0];
  return first ? [first, ...targets.filter((id) => id !== first)] : [];
}

export const generatedSaveMenu = (targets: readonly string[], nameOf: (id: string) => string) =>
  targets.map((id, at) => ({ id, title: `Save to ${nameOf(id)}`, checked: at === 0 }));

export const useGeneratedPasswords = create<{ list: VaultGeneratedPassword[] }>()(() => ({ list: [] }));

const keepDaysNow = () => useBrowser.getState().settings.vaultKeepGenerated;

const expiresAt = (createdAt: number, keepDays: number) => (keepDays < 0 ? Infinity : createdAt + keepDays * DAY_MS);

let keptNow: { list: readonly VaultGeneratedPassword[]; keepDays: number; from: number; until: number; kept: VaultGeneratedPassword[] } | null = null;

export function currentGeneratedPasswords(now = Date.now()): VaultGeneratedPassword[] {
  const list = useGeneratedPasswords.getState().list;
  const keepDays = keepDaysNow();
  const known = keptNow;
  if (known && known.list === list && known.keepDays === keepDays && now >= known.from && now < known.until) return known.kept;
  const kept = keptGenerated(list, keepDays, now);
  const until = kept.reduce((soonest, e) => Math.min(soonest, expiresAt(e.createdAt, keepDays)), Infinity);
  keptNow = { list, keepDays, from: now, until, kept };
  return kept;
}
const generatedPasswordOf = (id: string) => useGeneratedPasswords.getState().list.find((e) => e.id === id) ?? null;

let loads = 0;

export async function loadGeneratedPasswords() {
  const mine = ++loads;
  const list = await listGeneratedPasswords().catch(() => null);
  if (mine !== loads) return;
  if (list) useGeneratedPasswords.setState({ list });
}

const forget = (id: string) => useGeneratedPasswords.setState((s) => ({ list: s.list.filter((e) => e.id !== id) }));

let started = false;

export function startGeneratedPasswords() {
  if (started) return;
  started = true;
  onGeneratedPasswordsChanged(() => void loadGeneratedPasswords());
  void loadGeneratedPasswords();
}

export async function copyGenerated(id: string): Promise<VaultCopyOutcome> {
  return copyOutcomeOf(await copyGeneratedPassword(id).catch(() => null));
}

export async function deleteGenerated(id: string): Promise<boolean> {
  const result = await deleteGeneratedPassword(id).catch(() => null);
  if (result?.deleted) forget(id);
  void loadGeneratedPasswords();
  return !!result?.deleted;
}

export async function saveGenerated(id: string, provider: string, username: string | null, profile: string | null = null): Promise<VaultGeneratedSaveResult> {
  const consent = consentToken();
  const entry = generatedPasswordOf(id);
  const typed = username?.trim() || null;
  if (!typed && !entry?.username.trim()) return { saved: false, error: NEEDS_USERNAME };
  const into = isArdiaProvider(provider) ? (profile ?? "") : null;
  const result = await saveGeneratedPassword(id, provider, typed, into).catch((): VaultGeneratedSaveResult => ({ saved: false, error: "failed" }));
  if (!result.saved) return result;
  forget(id);
  if (entry && result.item) rememberVaultAccount(entry.origin, result.item, consent);
  void loadVaultItems(provider, true);
  void loadGeneratedPasswords();
  return result;
}
