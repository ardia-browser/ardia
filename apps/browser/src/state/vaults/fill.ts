import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import type { VaultFillError, VaultFillField, VaultItem, VaultKeyPress, VaultPasswordStyle } from "../../platform/vaults";
import { webviews } from "../../platform/webviews";
import { noteStandaloneCodeFilled, noteVaultCodeAutofill, noteVaultCodeFilled, noteVaultEarlyClickIgnored, noteVaultFill } from "../telemetry/vaultCounts";
import { isCodeItem } from "./standaloneCodesModel";
import { unlockProvider, openPasswordSettings, wasCancelled } from "./actions";
import { noteFilledUsername, rememberVaultAccount } from "./accounts";
import { prefetchVaultCode } from "./codes";
import {
  AFTER_FILL_QUIET_MS,
  dismissVaultMenu,
  noteGeneratedFill,
  noteVaultFieldCleared,
  patchVaultMenu,
  quietVaultField,
  reopenVaultMenuFromKey,
  resyncVaultPage,
  restVaultMenu,
  setVaultSuggestOpen,
  rowsOfMenu,
  showAllPasswords,
  showVaultMatches,
  useVaultMenus,
  vaultMenuOf,
  type VaultMenu,
} from "./menu";
import { menuKey, restingRow, soleRestingFill, type VaultRow } from "./menuModel";
import { vaultMenuShownFor } from "./menuShown";
import { rememberPending } from "./pendingTotp";
import { fillsWithoutChoice } from "./originMatch";
import { currentPendingTotp, loadVaultItems, setPendingTotp, vaultManagerName } from "./store";
import { contextPickOf, contextTargetOf, takeCodePick } from "./menuPicks";

const profileOfTab = (tabId: string) => useBrowser.getState().tabs[tabId]?.profileId ?? null;

export const TOUCH_ID_EXPIRED = "Touch ID timed out. Try again.";

export function fillErrorText(error: VaultFillError | string, provider: string): string {
  switch (error) {
    case "locked":
      return `${vaultManagerName(provider)} is locked. Unlock it to fill.`;
    case "originMismatch":
      return "This login is saved for another site.";
    case "insecure":
      return "This page isn't secure, so nothing was filled.";
    case "notFound":
      return `This login is no longer in ${vaultManagerName(provider)}.`;
    case "offline":
      return `You're offline, and ${vaultManagerName(provider)} needs the internet for this login.`;
    default:
      return "Couldn't fill this login. Try again.";
  }
}

const FILL_FAILED = { filled: [] as VaultFillField[], error: "failed" as const };

type VaultFillHow = { submit: boolean; touchID: boolean; explicit: boolean };
const BY_HAND: VaultFillHow = { submit: false, touchID: false, explicit: true };
export const BY_TOUCH_ID: VaultFillHow = { submit: true, touchID: true, explicit: true };
const BY_PAGE_KEY: VaultFillHow = { submit: false, touchID: false, explicit: false };
const CLICK_TO_FILL = "Click this login to fill it.";

export const needsExplicitPick = (row: VaultRow) => row.kind === "username" || ((row.kind === "login" || row.kind === "otp") && row.userChose);

function rememberCode(tabId: string, origin: string, item: VaultItem) {
  if (item.hasTotp === false || !fillsWithoutChoice(item, origin)) return;
  setPendingTotp(rememberPending(currentPendingTotp(), { origin, tabId, provider: item.provider, id: item.id, at: Date.now() }));
  if (item.hasTotp === true) prefetchVaultCode(item);
}

export const NOTHING_FILLED = "Couldn't find the field to fill. Click it and try again.";
export const NO_CODE = "This login has no one-time code.";

function finishFill(tabId: string, menu: VaultMenu) {
  quietVaultField(tabId, menu, AFTER_FILL_QUIET_MS);
  dismissVaultMenu(tabId, true);
}

async function fillItem(tabId: string, menu: VaultMenu, row: VaultRow, item: VaultItem, userChose: boolean, how: VaultFillHow, consent: ConsentToken | null) {
  const web = webviews.get(tabId);
  const fields: VaultFillField[] = menu.field === "otp" ? ["totp"] : ["username", "password"];
  patchVaultMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const request = { frameId: menu.frameId, origin: menu.origin, provider: item.provider, id: item.id, fields, userChose, submit: how.submit, ...contextPickOf(tabId, menu.seq) };
  const result = (web ? await web.fillFromVault(request).catch(() => null) : null) ?? FILL_FAILED;
  if (result.error !== "notAuthorized") noteVaultFill(result.error ?? (result.filled.length ? null : "failed"), consent);
  if (vaultMenuOf(tabId)?.seq !== menu.seq) return;
  if (result.error === "notAuthorized") {
    return patchVaultMenu(tabId, { busy: null, error: how.touchID ? TOUCH_ID_EXPIRED : null, touch: "off" }, menu.seq);
  }
  if (result.error) {
    if (result.error === "locked" || result.error === "notFound") void loadVaultItems(item.provider, true);
    const text = result.error === "notFound" && menu.field === "otp" ? NO_CODE : fillErrorText(result.error, item.provider);
    return patchVaultMenu(tabId, { busy: null, error: text, touch: "off" }, menu.seq);
  }
  if (!result.filled.length) return patchVaultMenu(tabId, { busy: null, error: NOTHING_FILLED, touch: "off" }, menu.seq);
  rememberVaultAccount(menu.origin, item, consent);
  if (menu.field !== "otp") noteFilledUsername(tabId, menu.origin, item.username);
  else {
    noteVaultCodeFilled(consent);
    if (isCodeItem(item)) noteStandaloneCodeFilled(consent);
  }
  finishFill(tabId, menu);
  if (menu.field !== "otp") rememberCode(tabId, menu.origin, item);
}

async function fillUsername(tabId: string, menu: VaultMenu, row: VaultRow, item: VaultItem, how: VaultFillHow) {
  const web = webviews.get(tabId);
  patchVaultMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const request = { frameId: menu.frameId, origin: menu.origin, provider: item.provider, id: item.id, fields: ["username" as const], userChose: true, submit: how.submit, ...contextTargetOf(tabId, menu.seq) };
  const result = web ? await web.fillFromVault(request).catch(() => null) : null;
  if (vaultMenuOf(tabId)?.seq !== menu.seq) return;
  if (!result?.filled.includes("username")) return patchVaultMenu(tabId, { busy: null, error: NOTHING_FILLED, touch: "off" }, menu.seq);
  noteFilledUsername(tabId, menu.origin, item.username);
  finishFill(tabId, menu);
}

async function fillGenerated(tabId: string, menu: VaultMenu, row: VaultRow, style: VaultPasswordStyle) {
  const web = webviews.get(tabId);
  patchVaultMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const request = { frameId: menu.frameId, origin: menu.origin, style, ...(menu.maxLength > 0 ? { maxLength: menu.maxLength } : {}), ...contextTargetOf(tabId, menu.seq) };
  const result = web ? await web.fillGeneratedPassword(request).catch(() => null) : null;
  if (vaultMenuOf(tabId)?.seq !== menu.seq) return;
  if (!result?.filled.length) return patchVaultMenu(tabId, { busy: null, error: "Couldn't fill a password here. Try again." }, menu.seq);
  noteGeneratedFill(tabId, menu.frameId, menu.origin, menu.field);
  finishFill(tabId, menu);
}

async function unlockFromMenu(tabId: string, menu: VaultMenu, row: VaultRow, provider: string, how: VaultFillHow, consent: ConsentToken | null) {
  patchVaultMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const result = await unlockProvider(provider, null, { tab: tabId, origin: menu.origin });
  if (vaultMenuOf(tabId)?.seq !== menu.seq) return;
  if (result.ok) {
    await loadVaultItems(provider, true);
    const now = vaultMenuOf(tabId);
    if (now?.seq !== menu.seq) return;
    const rows = rowsOfMenu(now, undefined, consent);
    const sole = soleRestingFill(rows);
    patchVaultMenu(tabId, { busy: null, touch: sole && how.touchID ? "granted" : "off", selected: sole ? rows.indexOf(sole) : restingRow(rows, now.remembered) }, menu.seq);
    if (sole) activateRow(tabId, sole, how, consent);
    return;
  }
  if (result.needs === "password") {
    dismissVaultMenu(tabId);
    return openPasswordSettings(profileOfTab(tabId));
  }
  if (wasCancelled(result)) return patchVaultMenu(tabId, { busy: null, touch: "off" }, menu.seq);
  patchVaultMenu(tabId, { busy: null, touch: "off", error: `Couldn't unlock ${vaultManagerName(provider)}. Try again.` }, menu.seq);
}

export const activateVaultRow = (tabId: string, row: VaultRow, how: VaultFillHow = BY_HAND) => activateRow(tabId, row, how, consentToken());

function activateRow(tabId: string, row: VaultRow, how: VaultFillHow, consent: ConsentToken | null) {
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.busy) return;
  if (!how.explicit && menu.mode !== "search" && needsExplicitPick(row)) {
    return patchVaultMenu(tabId, { error: CLICK_TO_FILL, ...(how.touchID ? { touch: "off" as const } : {}) }, menu.seq);
  }
  const pickCode = row.kind === "login" ? takeCodePick(tabId, menu.seq) : null;
  if (pickCode && row.kind === "login") {
    dismissVaultMenu(tabId, true);
    return pickCode(row.item);
  }
  switch (row.kind) {
    case "login":
      return void fillItem(tabId, menu, row, row.item, row.userChose || menu.mode === "search", how, consent);
    case "otp":
      return void fillItem(tabId, menu, row, row.item, row.userChose, how, consent);
    case "username":
      return void fillUsername(tabId, menu, row, row.item, how);
    case "generate":
      return void fillGenerated(tabId, menu, row, row.style);
    case "suggest":
      return setVaultSuggestOpen(tabId, true);
    case "unlock":
      return void unlockFromMenu(tabId, menu, row, row.provider, how, consent);
    case "allPasswords":
      return showAllPasswords(tabId);
    case "openPasswords":
    case "settings":
      dismissVaultMenu(tabId);
      return openPasswordSettings(profileOfTab(tabId));
  }
}

export const EARLY_CLICK_MS = 500;

export function clickVaultRow(tabId: string, row: VaultRow) {
  if (vaultMenuShownFor(tabId) < EARLY_CLICK_MS) return noteVaultEarlyClickIgnored();
  activateVaultRow(tabId, row);
}

export function stepVaultMenu(tabId: string, key: string, how: VaultFillHow = BY_HAND) {
  restVaultMenu(tabId);
  const menu = vaultMenuOf(tabId);
  if (!menu) return;
  const rows = rowsOfMenu(menu);
  const { selected, action } = menuKey(menu.selected, rows.length, key);
  if (action === "close") {
    if (menu.mode === "search" && key === "Escape") return showVaultMatches(tabId);
    if (menu.suggestOpen && key === "Escape") return setVaultSuggestOpen(tabId, false);
    if (key === "Escape") quietVaultField(tabId, menu, null);
    return dismissVaultMenu(tabId, menu.mode === "search");
  }
  if (action === "move") return patchVaultMenu(tabId, { selected, error: null });
  if (action === "activate") activateVaultRow(tabId, rows[selected]!, how);
}

export function noteVaultKey(tabId: string, event: VaultKeyPress) {
  const menu = vaultMenuOf(tabId);
  const ours = !!menu && menu.frameId === event.frameId;
  if (event.key === "Typed") return void (ours && menu.mode !== "search" && dismissVaultMenu(tabId));
  if (event.key === "Cleared") return noteVaultFieldCleared(tabId, event.frameId);
  if (!ours) {
    if (event.key === "ArrowDown") reopenVaultMenuFromKey(tabId, event.frameId);
    else resyncVaultPage(tabId, event.frameId);
    return;
  }
  if (menu.mode === "search") return void (event.key === "Escape" && dismissVaultMenu(tabId));
  if (menu.hidden) return;
  stepVaultMenu(tabId, event.key);
}

export const noteCodeUnavailable = (tabId: string, seq: number, key: string) => {
  const menu = vaultMenuOf(tabId);
  if (menu?.seq === seq && !menu.noTotp.includes(key)) patchVaultMenu(tabId, { noTotp: [...menu.noTotp, key] }, seq);
};

type CodeRow = Extract<VaultRow, { kind: "otp" }>;

export function autofillCodeRow(menu: Pick<VaultMenu, "field" | "hidden" | "busy" | "mode" | "onDemand">, rows: readonly VaultRow[]): CodeRow | null {
  if (menu.field !== "otp" || !menu.onDemand || menu.hidden || menu.busy || menu.mode !== "matches") return null;
  const pending = rows.filter((r): r is CodeRow => r.kind === "otp" && r.pending && !r.userChose && r.item.hasTotp === true);
  return pending.length === 1 ? pending[0]! : null;
}

export function startCodeAutofill() {
  const tried = new Map<string, number>();
  return useVaultMenus.subscribe((s, prev) => {
    if (s.menus === prev.menus) return;
    for (const [tabId, menu] of Object.entries(s.menus)) {
      if (!menu || menu.field !== "otp" || tried.get(tabId) === menu.seq) continue;
      const row = autofillCodeRow(menu, rowsOfMenu(menu));
      if (!row) continue;
      tried.set(tabId, menu.seq);
      setPendingTotp(currentPendingTotp().filter((p) => !(p.provider === row.item.provider && p.id === row.item.id)));
      noteVaultCodeAutofill();
      queueMicrotask(() => activateVaultRow(tabId, row, BY_PAGE_KEY));
    }
    for (const tabId of tried.keys()) if (!s.menus[tabId]) tried.delete(tabId);
  });
}
