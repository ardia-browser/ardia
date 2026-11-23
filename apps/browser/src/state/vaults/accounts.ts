import type { ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { readDocument, writeDocument } from "../../platform/documents";
import { searchVaultItems, type VaultItem } from "../../platform/vaults";
import { isFields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { itemKey, siteKey } from "./originMatch";

export const VAULT_ACCOUNTS_DOC = "vault-accounts.json";
export const MAX_REMEMBERED_ACCOUNTS = 500;
const VERSION = 1;
const SEARCH_MOST = 200;

type Remembered = { key: string; at: number };

let accounts: Map<string, Remembered> | null = null;
const usernamesThisSession = new Map<string, string>();

const isRemembered = (v: unknown): v is Remembered => isFields(v) && typeof v.key === "string" && typeof v.at === "number";

function read(): Map<string, Remembered> {
  let doc: ReturnType<typeof parseSaved> = null;
  try {
    doc = parseSaved(readDocument(VAULT_ACCOUNTS_DOC), VERSION);
  } catch {
    doc = null;
  }
  const sites = doc && isFields(doc.sites) ? doc.sites : {};
  const entries = Object.entries(sites).filter((e): e is [string, Remembered] => isRemembered(e[1]));
  return new Map(entries.sort((a, b) => a[1].at - b[1].at).slice(-MAX_REMEMBERED_ACCOUNTS));
}

const loaded = () => (accounts ??= read());

function save(map: Map<string, Remembered>, consent: ConsentToken | null) {
  try {
    writeDocument(VAULT_ACCOUNTS_DOC, versionedJson({ sites: Object.fromEntries(map) }, VERSION));
  } catch (error) {
    warnFor(consent, "[vaults] couldn't save the remembered logins", error);
  }
}

export function rememberVaultAccount(origin: string, item: { provider: string; id: string; username?: string }, consent: ConsentToken | null, now = Date.now()) {
  const site = siteKey(origin);
  if (!site) return;
  const map = loaded();
  map.delete(site);
  map.set(site, { key: itemKey(item), at: now });
  const username = item.username?.trim();
  if (username) usernamesThisSession.set(itemKey(item), username);
  else usernamesThisSession.delete(itemKey(item));
  while (map.size > MAX_REMEMBERED_ACCOUNTS) map.delete(map.keys().next().value!);
  save(map, consent);
}

export function rememberedVaultAccount(origin: string): string | null {
  const site = siteKey(origin);
  return (site && loaded().get(site)?.key) || null;
}

export const JUST_REMEMBERED_MS = 60_000;

export function rememberedVaultLogin(origin: string): (Remembered & { username?: string }) | null {
  const site = siteKey(origin);
  const entry = site ? loaded().get(site) : undefined;
  if (!entry) return null;
  const username = usernamesThisSession.get(entry.key);
  return username ? { ...entry, username } : entry;
}

export async function rememberedVaultItem(origin: string, listed: readonly VaultItem[]): Promise<VaultItem | undefined> {
  const remembered = rememberedVaultLogin(origin);
  if (!remembered) return undefined;
  const here = listed.find((item) => itemKey(item) === remembered.key);
  if (here || !remembered.username) return here;
  const found = await searchVaultItems(remembered.username, SEARCH_MOST, null).catch((): VaultItem[] => []);
  return found.find((item) => itemKey(item) === remembered.key);
}

export function forgetRememberedVaultAccount(origin: string, key: string, consent: ConsentToken | null, now = Date.now()) {
  const site = siteKey(origin);
  const map = loaded();
  const entry = site ? map.get(site) : undefined;
  if (!entry || entry.key !== key || now - entry.at < JUST_REMEMBERED_MS) return;
  map.delete(site);
  save(map, consent);
}

export function reloadVaultAccounts() {
  accounts = null;
}

const filled = new Map<string, { origin: string; username: string }>();

export function noteFilledUsername(tabId: string, origin: string, username: string) {
  if (username) filled.set(tabId, { origin, username });
}

export function filledUsername(tabId: string, origin: string): string {
  const last = filled.get(tabId);
  return last && siteKey(last.origin) === siteKey(origin) ? last.username : "";
}

export function forgetFilledUsernamesOutside(tabs: Readonly<Record<string, unknown>>) {
  for (const tabId of filled.keys()) if (!(tabId in tabs)) filled.delete(tabId);
}
