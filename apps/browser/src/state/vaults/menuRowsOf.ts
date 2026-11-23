import type { ConsentToken } from "../telemetry/choice";
import type { VaultFieldKind, VaultItem } from "../../platform/vaults";
import { noteVaultMenuRowsBuilt } from "../telemetry/vaultCounts";
import { useBrowser } from "../browser/store";
import { itemsForProfile } from "./ardia";
import { currentGeneratedPasswords, searchGenerated } from "./generated";
import { MAX_SEARCH_ROWS, menuRows, suggestOf, SUGGEST_NOTHING, type MenuMode, type VaultRow, type VaultSuggest } from "./menuModel";
import { anyProfileOnArdia } from "./enabled";
import { pendingFor } from "./pendingTotp";
import { siteItemsNow, siteItemsOf, useVaults } from "./store";
import { menuUsernamesNow, recommendedNow, searchResultsNow, typedResultsNow } from "./menuCaches";
import { currentCodeItems } from "./standaloneCodes";
import { offeredPasskeys } from "./passkeyStore";

export type VaultsNow = ReturnType<typeof useVaults.getState>;

type RowInputs = {
  tabId?: string | null;
  field: VaultFieldKind;
  mode: MenuMode;
  origin: string;
  query: string;
  typed?: string;
  pageUsername?: string | null;
  noTotp: readonly string[];
  remembered: string | null;
  email: boolean;
  suggestOpen: boolean;
  profile: string | null;
  webauthn?: boolean;
};

export const currentVaultSuggest = (): VaultSuggest => (anyProfileOnArdia() ? suggestOf(useBrowser.getState().settings) : SUGGEST_NOTHING);

type Built = { key: unknown[]; rows: VaultRow[] };
const recent: Built[] = [];
const RECENT = 4;

useVaults.subscribe((s, prev) => {
  if (s.itemsStamp !== prev.itemsStamp || s.listed.length < prev.listed.length) recent.length = 0;
});

function keyOf(menu: RowInputs, vaults: VaultsNow, suggest: VaultSuggest, now: number): unknown[] {
  const pending = pendingFor(vaults.pending, menu.origin, menu.tabId ?? null, now);
  const generated = menu.mode === "search" ? currentGeneratedPasswords(now) : null;
  const codes = menu.field === "otp" ? currentCodeItems() : null;
  const passkeys = menu.webauthn && menu.mode === "matches" ? offeredPasskeys(menu.tabId, menu.origin) : null;
  const items = menu.mode === "search" ? searchResultsNow(menu.query, menu.profile) : (siteItemsNow(menu.origin), siteItemsOf(vaults, menu.origin));
  const usernames = menu.mode === "matches" && menu.field === "username" ? menuUsernamesNow(menu.email, menu.profile) : null;
  const typing = menu.mode === "matches" && !!menu.typed && !!menu.tabId;
  const typed = typing ? typedResultsNow(menu.tabId!, menu.typed!, menu.origin, menu.profile) : null;
  const recommended = menu.mode === "matches" && !typing ? recommendedNow(menu.origin, menu.profile, menu.pageUsername ?? null, menu.remembered) : null;
  return [vaults.providers, items, codes, pending, generated, menu.field, menu.mode, menu.origin, menu.query, menu.noTotp, menu.remembered, menu.email, menu.suggestOpen, menu.profile, passkeys, usernames, typing, typed, recommended, ...Object.values(suggest)];
}

const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function rowsOfMenu(menu: RowInputs, vaults: VaultsNow = useVaults.getState(), consent?: ConsentToken | null): VaultRow[] {
  const now = Date.now();
  const suggest = currentVaultSuggest();
  const key = keyOf(menu, vaults, suggest, now);
  const hit = recent.find((b) => sameKey(b.key, key));
  if (hit) return hit.rows;
  const started = performance.now();
  const rows = menuRows({
    field: menu.field,
    mode: menu.mode,
    origin: menu.origin,
    query: menu.query,
    providers: vaults.providers,
    items: itemsForProfile(key[1] as readonly VaultItem[], menu.profile),
    pending: key[3] as ReturnType<typeof pendingFor>,
    noTotp: new Set(menu.noTotp),
    remembered: menu.remembered,
    email: menu.email,
    generated: key[4] ? searchGenerated(key[4] as ReturnType<typeof currentGeneratedPasswords>, menu.query, MAX_SEARCH_ROWS) : [],
    codes: (key[2] as ReturnType<typeof currentCodeItems> | null) ?? undefined,
    suggestOpen: menu.suggestOpen,
    suggest,
    passkeys: (key[14] as ReturnType<typeof offeredPasskeys> | null) ?? undefined,
    usernames: key[15] ? itemsForProfile(key[15] as readonly VaultItem[], menu.profile) : undefined,
    typed: key[16] ? ((key[17] as readonly VaultItem[] | null) ?? []) : undefined,
    recommended: (key[18] as readonly VaultItem[] | null) ?? undefined,
  });
  noteVaultMenuRowsBuilt(performance.now() - started, consent);
  recent.unshift({ key, rows });
  recent.length = Math.min(recent.length, RECENT);
  return rows;
}
