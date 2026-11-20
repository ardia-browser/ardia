import { create } from "zustand";
import type { VaultField, VaultFieldKind, VaultFieldRect } from "../../platform/vaults";
import { noteMenuShown } from "./menuShown";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { rememberedVaultAccount } from "./accounts";
import { shownTabIds } from "../tabs/shownTabs";
import { rowsOfMenu, type VaultsNow } from "./menuRowsOf";
import { prefetchVaultCode } from "./codes";
import { forgetClosedVaultSaves, forgetVaultPageSaves } from "./saveOffer";
import { hasMatchRow, restingRow, type MenuMode, type VaultRow } from "./menuModel";
import { isSecureOrigin } from "./originMatch";
import { passwordProfileOfTab } from "./ardia";
import { anyVaultConnectedForTab, loadAllVaultItems, refreshVaultBiometrics, useVaults } from "./store";
import { vaultsOnForTab } from "./enabled";
import { fieldProviderFillOfTab } from "../site/passwordManager";
import { ardiaFillsInTab } from "./ardiaSources";
import { usePasskeys } from "./passkeyStore";
import { declinedAt, declineField, hearFieldAgain, isQuiet, quietTabIds } from "./menuQuiet";

export { AFTER_FILL_QUIET_MS, quietVaultField } from "./menuQuiet";

type FrameId = VaultField["frameId"];

export type VaultTouchPhase = "off" | "ready" | "retry" | "granted" | "unavailable" | "lockout";

export type VaultMenu = {
  seq: number;
  tabId: string | null;
  frameId: FrameId;
  origin: string;
  field: VaultFieldKind;
  rect: VaultFieldRect | null;
  maxLength: number;
  mode: MenuMode;
  query: string;
  selected: number;
  selectedKey: string | null;
  onDemand: boolean;
  error: string | null;
  busy: string | null;
  hovered: boolean;
  hidden: boolean;
  noTotp: string[];
  remembered: string | null;
  email: boolean;
  suggestOpen: boolean;
  touch: VaultTouchPhase;
  touchRetries: number;
  touchRearms: number;
  profile: string | null;
  webauthn: boolean;
};

type FieldSeen = VaultField & { at: number };

export const useVaultMenus = create<{ menus: Record<string, VaultMenu | null>; fields: Record<string, FieldSeen | null> }>()(() => ({ menus: {}, fields: {} }));

const menus = () => useVaultMenus.getState().menus;
export const vaultMenuOf = (tabId: string) => menus()[tabId] ?? null;
const lastVaultField = (tabId: string) => useVaultMenus.getState().fields[tabId] ?? null;

let seq = 0, focusSeq = 0, pressedAt = 0;
const BLUR_GRACE_MS = 100;

export const noteVaultMenuPress = () => void (pressedAt = Date.now());

const searchFocused = new Set<string>();

export function noteVaultSearchFocus(tabId: string, focused: boolean) {
  if (focused) return void searchFocused.add(tabId);
  searchFocused.delete(tabId);
  const menu = vaultMenuOf(tabId);
  if (menu?.mode === "search") setTimeout(() => closeAfterBlur(tabId, menu.seq), BLUR_GRACE_MS);
}

const declinedNow = (tabId: string, field: FieldSeen) => declinedAt(tabId, field.at);

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function setMenu(tabId: string, menu: VaultMenu | null) {
  noteMenuShown(tabId, vaultMenuOf(tabId), menu);
  useVaultMenus.setState((s) => (menu ? { menus: { ...s.menus, [tabId]: menu } } : tabId in s.menus ? { menus: withoutKey(s.menus, tabId) } : s));
}

const told = new Map<string, { frameId: FrameId; open: boolean; highlighted: boolean }>();

function tellPage(tabId: string, frameId: FrameId, open: boolean, highlighted = false) {
  told.set(tabId, { frameId, open, highlighted: open && highlighted });
  const sent = webviews.get(tabId)?.setVaultMenu({ frameId, open, highlighted });
  void sent?.catch(() => {
    const menu = vaultMenuOf(tabId);
    const last = told.get(tabId);
    if (!open || !menu || menu.frameId !== frameId || last?.frameId !== frameId || !last.open) return;
    void webviews.get(tabId)?.setVaultMenu({ frameId, open: last.open, highlighted: last.highlighted })?.catch(() => closeVaultMenu(tabId));
  });
}

const tellPageOfMenu = (tabId: string, menu: VaultMenu) => tellPage(tabId, menu.frameId, !menu.hidden, !menu.hidden && menu.selected >= 0);

export function resyncVaultPage(tabId: string, frameId: FrameId) {
  const menu = vaultMenuOf(tabId);
  if (menu && menu.frameId === frameId) return tellPageOfMenu(tabId, menu);
  tellPage(tabId, frameId, false);
}

const keyAt = (rows: readonly VaultRow[], selected: number) => rows[selected]?.key ?? null;

function withSelection(menu: VaultMenu, chosen: boolean): VaultMenu {
  const rows = rowsOfMenu(menu);
  if (chosen) return { ...menu, selectedKey: keyAt(rows, menu.selected) };
  if (menu.busy || keyAt(rows, menu.selected) === menu.selectedKey) return menu;
  const same = menu.selectedKey === null ? -1 : rows.findIndex((r) => r.key === menu.selectedKey);
  const selected = same >= 0 ? same : menu.mode === "search" ? (rows.length && menu.selected >= 0 ? 0 : -1) : restingRow(rows, menu.remembered);
  return { ...menu, selected, selectedKey: keyAt(rows, selected) };
}

export function patchVaultMenu(tabId: string, patch: Partial<VaultMenu>, onlySeq?: number) {
  const menu = vaultMenuOf(tabId);
  if (!menu || (onlySeq !== undefined && menu.seq !== onlySeq)) return;
  const next = withSelection({ ...menu, ...patch }, "selected" in patch);
  setMenu(tabId, next);
  if (next.hidden !== menu.hidden || (!next.hidden && next.selected !== menu.selected)) tellPageOfMenu(tabId, next);
}

export { rowsOfMenu };

export function restVaultMenu(tabId: string) {
  const menu = vaultMenuOf(tabId);
  if (menu && withSelection(menu, false) !== menu) patchVaultMenu(tabId, {}, menu.seq);
}

export const restingRowOf = (menu: VaultMenu) => restingRow(rowsOfMenu(menu), menu.remembered);

export function closeVaultMenu(tabId: string, refocus = false) {
  const menu = vaultMenuOf(tabId);
  if (!menu) return;
  setMenu(tabId, null);
  searchFocused.delete(tabId);
  tellPage(tabId, menu.frameId, false);
  if (refocus && (menu.mode === "search" || lastVaultField(tabId)?.focused === false)) void webviews.get(tabId)?.focus();
}

export function dismissVaultMenu(tabId: string, refocus = false) {
  const field = lastVaultField(tabId);
  if (field?.focused) declineField(tabId, field.at);
  closeVaultMenu(tabId, refocus);
}

const blankMenu = (field: FieldSeen, onDemand: boolean, profile: string | null = null, tabId: string | null = null): VaultMenu => ({
  seq: 0,
  tabId,
  frameId: field.frameId,
  origin: field.origin,
  field: field.kind,
  rect: field.rect,
  maxLength: field.maxLength ?? 0,
  mode: "matches",
  query: "",
  selected: -1,
  selectedKey: null,
  onDemand,
  error: null,
  busy: null,
  hovered: false,
  hidden: false,
  noTotp: [],
  remembered: rememberedVaultAccount(field.origin),
  email: !!field.email,
  suggestOpen: false,
  touch: "off",
  touchRetries: 0,
  touchRearms: 0,
  profile,
  webauthn: !!field.webauthn,
});

function openMenu(tabId: string, field: FieldSeen, onDemand: boolean) {
  const old = vaultMenuOf(tabId);
  if (old && old.frameId !== field.frameId) tellPage(tabId, old.frameId, false);
  const menu: VaultMenu = { ...blankMenu(field, onDemand, passwordProfileOfTab(tabId), tabId), seq: ++seq };
  const opened = withSelection({ ...menu, selected: restingRowOf(menu) }, true);
  setMenu(tabId, opened);
  tellPageOfMenu(tabId, opened);
  refreshVaultBiometrics();
  prefetchCodesOf(opened);
}

function prefetchCodesOf(menu: VaultMenu) {
  if (menu.field !== "otp") return;
  for (const row of rowsOfMenu(menu)) if (row.kind === "otp") prefetchVaultCode(row.item);
}

const suggestOnFocus = () => useBrowser.getState().settings.vaultSuggestOnFocus;

const canOffer = (tabId: string, field: FieldSeen | null): field is FieldSeen => !!field?.focused && !!field.rect && isSecureOrigin(field.origin) && anyVaultConnectedForTab(tabId) && ardiaFillsInTab(tabId);

function offerNow(tabId: string, field: FieldSeen): boolean {
  const now = lastVaultField(tabId);
  if (!canOffer(tabId, now) || now.at !== field.at || vaultMenuOf(tabId) || declinedNow(tabId, now) || !now.main || !suggestOnFocus()) return true;
  if (isQuiet(tabId, now)) return true;
  if (!hasMatchRow(rowsOfMenu(blankMenu(now, false, passwordProfileOfTab(tabId), tabId)))) return false;
  openMenu(tabId, now, false);
  return true;
}

async function offerOnFocus(tabId: string, field: FieldSeen) {
  const settled = offerNow(tabId, field);
  const loading = loadAllVaultItems();
  if (settled) return void loading;
  await loading;
  offerNow(tabId, field);
}

function openOnDemand(tabId: string, field: FieldSeen) {
  hearFieldAgain(tabId);
  if (!canOffer(tabId, field)) return false;
  const menu = vaultMenuOf(tabId);
  if (menu && menu.frameId === field.frameId && menu.field === field.kind) {
    tellPageOfMenu(tabId, menu);
    return true;
  }
  openMenu(tabId, field, true);
  void loadAllVaultItems();
  return true;
}

export function noteVaultField(tabId: string, event: VaultField) {
  const menuOn = vaultsOnForTab(tabId);
  if (!menuOn && fieldProviderFillOfTab(tabId) !== "system") return;
  const previous = lastVaultField(tabId);
  const sameField = !!previous && previous.focused && previous.frameId === event.frameId && previous.kind === event.kind;
  const seen: FieldSeen = { ...event, at: sameField && event.focused ? previous.at : ++focusSeq };
  useVaultMenus.setState((s) => ({ fields: { ...s.fields, [tabId]: seen } }));
  if (!menuOn) return;
  const menu = vaultMenuOf(tabId);
  if (!event.focused) {
    if (menu && menu.frameId === event.frameId) setTimeout(() => closeAfterBlur(tabId, menu.seq), BLUR_GRACE_MS);
    return;
  }
  if (menu && menu.frameId === event.frameId && menu.field === event.kind) {
    patchVaultMenu(tabId, { rect: event.rect, origin: event.origin, maxLength: event.maxLength ?? menu.maxLength });
    if (!sameField || event.clicked) tellPageOfMenu(tabId, vaultMenuOf(tabId)!);
    return;
  }
  if (menu) closeVaultMenu(tabId);
  if (event.clicked) return void openOnDemand(tabId, seen);
  if (sameField || isQuiet(tabId, event) || event.auto) return;
  if (!event.main || !canOffer(tabId, seen) || !suggestOnFocus()) return;
  void offerOnFocus(tabId, seen);
}

function closeAfterBlur(tabId: string, menuSeq: number) {
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.seq !== menuSeq || (menu.mode === "search" && searchFocused.has(tabId)) || menu.hovered || menu.busy || lastVaultField(tabId)?.focused) return;
  if (Date.now() - pressedAt <= 2 * BLUR_GRACE_MS) return;
  closeVaultMenu(tabId);
}

export function openVaultMenuOnDemand(tabId: string): boolean {
  const field = lastVaultField(tabId);
  return !!field && openOnDemand(tabId, field);
}

export function toggleVaultMenuFromBadge(tabId: string): "opened" | "closed" | null {
  const field = lastVaultField(tabId);
  const menu = vaultMenuOf(tabId);
  if (field && menu && !menu.hidden && menu.frameId === field.frameId && menu.field === field.kind) {
    dismissVaultMenu(tabId);
    return "closed";
  }
  return openVaultMenuOnDemand(tabId) ? "opened" : null;
}

export function reopenVaultMenuFromKey(tabId: string, frameId: FrameId): boolean {
  const field = lastVaultField(tabId);
  if (!field || field.frameId !== frameId) return false;
  return openOnDemand(tabId, field);
}

type GeneratedFill = { frameId: FrameId; origin: string; kind: VaultFieldKind };
const generatedFills = new Map<string, GeneratedFill>();

export const noteGeneratedFill = (tabId: string, frameId: FrameId, origin: string, kind: VaultFieldKind) => void generatedFills.set(tabId, { frameId, origin, kind });

export function noteVaultFieldCleared(tabId: string, frameId: FrameId) {
  const generated = generatedFills.get(tabId);
  const abandoned = !!generated && generated.frameId === frameId && lastVaultField(tabId)?.kind === generated.kind;
  if (generated && abandoned) {
    generatedFills.delete(tabId);
    void webviews.get(tabId)?.discardVaultCapture({ origin: generated.origin })?.catch(() => {});
  }
  const menu = vaultMenuOf(tabId);
  if (menu && menu.frameId === frameId) return;
  if (abandoned) return void reopenVaultMenuFromKey(tabId, frameId);
  offerVaultMenuAgain(tabId, frameId);
}

function offerVaultMenuAgain(tabId: string, frameId: FrameId) {
  const field = lastVaultField(tabId);
  if (!field || field.frameId !== frameId || vaultMenuOf(tabId)) return;
  hearFieldAgain(tabId);
  if (canOffer(tabId, field) && field.main && suggestOnFocus()) void offerOnFocus(tabId, field);
}

export function setVaultMenuOffscreen(tabId: string, menuSeq: number, offscreen: boolean) {
  const menu = vaultMenuOf(tabId);
  if (menu?.seq === menuSeq && menu.hidden !== offscreen) patchVaultMenu(tabId, { hidden: offscreen, hovered: offscreen ? false : menu.hovered }, menuSeq);
}

export const selectVaultRow = (tabId: string, selected: number) => void (vaultMenuOf(tabId)?.selected !== selected && patchVaultMenu(tabId, { selected }));
export function hoverVaultMenu(tabId: string, hovered: boolean) {
  const menu = vaultMenuOf(tabId);
  if (!hovered && menu && menu.mode !== "search" && !menu.busy && lastVaultField(tabId)?.focused === false) return closeVaultMenu(tabId);
  if (!hovered && menu && menu.mode === "matches" && !menu.busy) return patchVaultMenu(tabId, { hovered, selected: restingRowOf(menu) });
  patchVaultMenu(tabId, { hovered });
}
export const searchVaultMenu = (tabId: string, query: string) => patchVaultMenu(tabId, { query, selected: query ? 0 : -1 });
export function setVaultSuggestOpen(tabId: string, open: boolean) {
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.mode !== "matches") return;
  const rows = rowsOfMenu({ ...menu, suggestOpen: open });
  const selected = open ? rows.findIndex((r) => r.kind === "generate") : rows.findIndex((r) => r.kind === "suggest");
  patchVaultMenu(tabId, { suggestOpen: open, selected, error: null });
}
export function showAllPasswords(tabId: string) {
  if (!vaultMenuOf(tabId)) return;
  searchFocused.add(tabId);
  patchVaultMenu(tabId, { mode: "search", query: "", selected: -1, error: null });
}
export function showVaultMatches(tabId: string) {
  const menu = vaultMenuOf(tabId);
  if (!menu) return;
  if (menu.mode === "search") {
    searchFocused.delete(tabId);
    void webviews.get(tabId)?.focus();
  }
  const matches = { ...menu, mode: "matches" as const, query: "" };
  patchVaultMenu(tabId, { mode: "matches", query: "", selected: restingRowOf(matches), error: null });
}

export function forgetVaultPage(tabId: string) {
  closeVaultMenu(tabId);
  forgetVaultPageSaves(tabId);
  generatedFills.delete(tabId);
  hearFieldAgain(tabId);
  told.delete(tabId);
  searchFocused.delete(tabId);
  useVaultMenus.setState((s) => (tabId in s.fields ? { fields: withoutKey(s.fields, tabId) } : s));
}

function forgetClosedTabs(tabs: Readonly<Record<string, unknown>>) {
  const { menus: open, fields } = useVaultMenus.getState();
  const known = new Set([...Object.keys(open), ...Object.keys(fields), ...told.keys(), ...quietTabIds(), ...generatedFills.keys()]);
  for (const tabId of known) if (!(tabId in tabs)) forgetVaultPage(tabId);
}

export function offerToFocusedField(tabId: string) {
  const field = lastVaultField(tabId);
  if (!canOffer(tabId, field) || field.auto || !field.main || !suggestOnFocus() || vaultMenuOf(tabId) || declinedNow(tabId, field) || isQuiet(tabId, field) || !shownTabIds(useBrowser.getState()).has(tabId)) return;
  void offerOnFocus(tabId, field);
}

const unlockedCount = (s: VaultsNow) => s.providers.filter((p) => p.state === "unlocked").length;

function offerToFocusedFields() {
  for (const tabId of Object.keys(useVaultMenus.getState().fields)) offerToFocusedField(tabId);
}

const restOpenMenus = () => {
  for (const tabId of Object.keys(menus())) restVaultMenu(tabId);
};

export function startVaultMenus() {
  const stopTabs = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.windows === prev.windows && s.splits === prev.splits) return;
    if (s.tabs !== prev.tabs) {
      forgetClosedTabs(s.tabs);
      forgetClosedVaultSaves(s.tabs);
    }
    const open = Object.entries(menus()).filter(([, menu]) => menu);
    if (!open.length) return;
    const shown = shownTabIds(s);
    for (const [tabId] of open) if (!shown.has(tabId)) closeVaultMenu(tabId);
  });
  const readyManagers = (s: VaultsNow) => s.providers.filter((p) => p.state === "locked" || (p.state === "unlocked" && p.id in s.items)).length;
  const stopVaults = useVaults.subscribe((s, prev) => {
    if (readyManagers(s) > readyManagers(prev) || unlockedCount(s) > unlockedCount(prev)) offerToFocusedFields();
    if (s.providers !== prev.providers || s.items !== prev.items || s.pending !== prev.pending) restOpenMenus();
  });
  const stopPasskeys = usePasskeys.subscribe((s, prev) => s.offers !== prev.offers && restOpenMenus());
  return () => {
    stopTabs();
    stopVaults();
    stopPasskeys();
  };
}
