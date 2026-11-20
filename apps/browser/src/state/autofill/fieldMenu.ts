import { consentToken, type ConsentToken } from "../telemetry/choice";
import { nativeConsent } from "../telemetry/nativeConsent";
import { create } from "zustand";
import { claimAutofillMenuKeys, fillAutofillEntry, onAutofillField, onAutofillMenuKey, type AutofillFieldEvent, type AutofillFieldKind, type AutofillFieldPart, type AutofillFieldRect } from "../../platform/autofill";
import { dropVaultTouchGrant, type VaultTouchIDStatus } from "../../platform/vaults";
import { useBrowser } from "../browser/store";
import { currentEngineProfile } from "../browser/current";
import { openSettings, SETTINGS_DETAIL } from "../settings/settingsWindows";
import { regularProfileId } from "../site/passwordManagerChoice";
import { addresses, autofillEnabled, cards } from "../settings/paneData";
import { cached, load } from "../settings/resources";
import { shownTabIds } from "../tabs/shownTabs";
import { noteAutofillMenuFill, noteAutofillMenuOpen, noteCardFillMoved, noteCardReauthDeclined } from "../telemetry/autofillCounts";
import { claimChromeDropdowns } from "../vaults/chromeDropdown";
import type { VaultTouchPhase } from "../vaults/menu";
import { menuKey } from "../vaults/menuModel";
import { touchScope } from "../vaults/touchScopes";
import { vaultsOnForTab, vaultsSupported } from "../vaults/enabled";
import { autofillMenuRows, autofillRestingRow, isTouchCardRow, type AutofillRow } from "./menuModel";

export type AutofillField = { kind: AutofillFieldKind; part: AutofillFieldPart; rect: AutofillFieldRect; at: number };

export type AutofillMenu = {
  seq: number;
  tabId: string;
  kind: AutofillFieldKind;
  part: AutofillFieldPart;
  rect: AutofillFieldRect;
  profile: string;
  selected: number;
  hovered: boolean;
  hidden: boolean;
  busy: string | null;
  error: string | null;
  touch: VaultTouchPhase;
  touchRetries: number;
  touchRearms: number;
};

export const useAutofillMenus = create<{ fields: Record<string, AutofillField | null>; menus: Record<string, AutofillMenu | null> }>()(() => ({ fields: {}, menus: {} }));

const CLAIM_SOURCE = "autofillMenu";
const FIELD_CLAIM_SOURCE = "autofillField";
const BLUR_GRACE_MS = 100;
const AFTER_FILL_QUIET_MS = 1500;

const ERRORS = {
  declined: "Touch ID or your password is needed.",
  failed: "Couldn't fill this form. Try again.",
} as const;

let seq = 0;
let focusSeq = 0;
const quiet = new Map<string, { kind: AutofillFieldKind; until: number }>();
const declined = new Map<string, number>();
let armed: { tabId: string; seq: number } | null = null;

export const autofillFieldOf = (tabId: string) => useAutofillMenus.getState().fields[tabId] ?? null;
export const autofillMenuOf = (tabId: string) => useAutofillMenus.getState().menus[tabId] ?? null;

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function setMenu(tabId: string, menu: AutofillMenu | null) {
  useAutofillMenus.setState((s) => (menu ? { menus: { ...s.menus, [tabId]: menu } } : tabId in s.menus ? { menus: withoutKey(s.menus, tabId) } : s));
}

export function patchAutofillMenu(tabId: string, patch: Partial<AutofillMenu>, onlySeq?: number) {
  const menu = autofillMenuOf(tabId);
  if (!menu || (onlySeq !== undefined && menu.seq !== onlySeq)) return;
  setMenu(tabId, { ...menu, ...patch });
}

const profileOfTab = (tabId: string) => {
  const tab = useBrowser.getState().tabs[tabId];
  return tab ? currentEngineProfile(tab.profileId) : null;
};

function refresh(profile: string) {
  return Promise.allSettled([load(addresses, [profile], { fresh: true }), load(cards, [profile], { fresh: true }), load(autofillEnabled, [profile])]).then(() => undefined);
}

export function autofillRowsOf(menu: Pick<AutofillMenu, "kind" | "part" | "profile">, now = new Date()): AutofillRow[] {
  return autofillMenuRows({
    kind: menu.kind,
    part: menu.part,
    addresses: cached(addresses, [menu.profile]) ?? [],
    cards: cached(cards, [menu.profile]) ?? [],
    enabled: cached(autofillEnabled, [menu.profile]) ?? { addresses: true, cards: true },
    now,
  });
}

function release(tabId: string) {
  void claimChromeDropdowns(tabId, CLAIM_SOURCE, [], null, consentToken());
  void claimAutofillMenuKeys(tabId, false).catch(() => undefined);
}

export function closeAutofillMenu(tabId: string) {
  const menu = autofillMenuOf(tabId);
  if (!menu) return;
  setMenu(tabId, null);
  if (armed?.tabId === tabId) armed = null;
  release(tabId);
}

const claimField = (tabId: string, kind: AutofillFieldKind | null) => void claimChromeDropdowns(tabId, FIELD_CLAIM_SOURCE, kind ? [kind] : [], null, consentToken());

export function dismissAutofillMenu(tabId: string) {
  const field = autofillFieldOf(tabId);
  if (field) declined.set(tabId, field.at);
  claimField(tabId, null);
  closeAutofillMenu(tabId);
}

function open(tabId: string, field: AutofillField, profile: string, consent: ConsentToken | null): boolean {
  const base = { kind: field.kind, part: field.part, profile };
  const rows = autofillRowsOf(base);
  if (!rows.length) return false;
  const menu: AutofillMenu = { ...base, seq: ++seq, tabId, rect: field.rect, selected: autofillRestingRow(rows), hovered: false, hidden: false, busy: null, error: null, touch: "off", touchRetries: 0, touchRearms: 0 };
  setMenu(tabId, menu);
  void claimChromeDropdowns(tabId, CLAIM_SOURCE, [field.kind], null, consent);
  void claimAutofillMenuKeys(tabId, true).catch(() => undefined);
  noteAutofillMenuOpen(consent);
  return true;
}

const stillFocused = (tabId: string, field: AutofillField) => autofillFieldOf(tabId)?.at === field.at;

const wanted = (tabId: string, field: AutofillField) =>
  stillFocused(tabId, field) && declined.get(tabId) !== field.at && !isQuiet(tabId, field.kind) && shownTabIds(useBrowser.getState()).has(tabId);

function prepare(tabId: string, field: AutofillField, profile: string) {
  const claim = () => claimField(tabId, autofillRowsOf({ ...field, profile }).length ? field.kind : null);
  claim();
  void refresh(profile).then(() => stillFocused(tabId, field) && claim());
}

function offer(tabId: string, field: AutofillField, profile: string, consent: ConsentToken | null) {
  const known = !!cached(addresses, [profile]) && !!cached(cards, [profile]);
  if (known && open(tabId, field, profile, consent)) return;
  void refresh(profile).then(() => {
    if (wanted(tabId, field) && !autofillMenuOf(tabId)) open(tabId, field, profile, consent);
  });
}

function isQuiet(tabId: string, kind: AutofillFieldKind) {
  const hush = quiet.get(tabId);
  if (!hush) return false;
  if (hush.kind !== kind || Date.now() > hush.until) {
    quiet.delete(tabId);
    return false;
  }
  return true;
}

export function noteAutofillField(event: AutofillFieldEvent) {
  if (!vaultsSupported) return;
  const { tabId } = event;
  const previous = autofillFieldOf(tabId);
  if (!event.focused) {
    useAutofillMenus.setState((s) => ({ fields: { ...s.fields, [tabId]: null } }));
    claimField(tabId, null);
    const menu = autofillMenuOf(tabId);
    if (menu) setTimeout(() => closeAfterBlur(tabId, menu.seq), BLUR_GRACE_MS);
    return;
  }
  if (!vaultsOnForTab(tabId)) return;
  const same = !!previous && previous.kind === event.kind && previous.part === event.part && event.trigger === "ask";
  const field: AutofillField = { kind: event.kind, part: event.part, rect: event.rect, at: same ? previous.at : ++focusSeq };
  useAutofillMenus.setState((s) => ({ fields: { ...s.fields, [tabId]: field } }));
  const menu = autofillMenuOf(tabId);
  if (menu && same) return patchAutofillMenu(tabId, { rect: field.rect });
  if (menu) closeAutofillMenu(tabId);
  const profile = profileOfTab(tabId);
  if (profile === null || !shownTabIds(useBrowser.getState()).has(tabId)) return;
  if (event.trigger === "focus") return prepare(tabId, field, profile);
  if (wanted(tabId, field)) offer(tabId, field, profile, nativeConsent(event));
}

function closeAfterBlur(tabId: string, menuSeq: number) {
  const menu = autofillMenuOf(tabId);
  if (!menu || menu.seq !== menuSeq || menu.hovered || menu.busy || autofillFieldOf(tabId)) return;
  closeAutofillMenu(tabId);
}

export function toggleAutofillMenuFromBadge(tabId: string): boolean {
  if (autofillMenuOf(tabId)) {
    dismissAutofillMenu(tabId);
    return true;
  }
  const field = autofillFieldOf(tabId);
  const profile = profileOfTab(tabId);
  if (!field || profile === null) return false;
  declined.delete(tabId);
  quiet.delete(tabId);
  return open(tabId, field, profile, consentToken());
}

export const selectAutofillRow = (tabId: string, selected: number) => void (autofillMenuOf(tabId)?.selected !== selected && patchAutofillMenu(tabId, { selected }));

export function hoverAutofillMenu(tabId: string, hovered: boolean) {
  const menu = autofillMenuOf(tabId);
  if (!menu) return;
  if (!hovered && !menu.busy && !autofillFieldOf(tabId)) return closeAutofillMenu(tabId);
  patchAutofillMenu(tabId, hovered ? { hovered } : { hovered, selected: autofillRestingRow(autofillRowsOf(menu)) });
}

export function setAutofillMenuOffscreen(tabId: string, menuSeq: number, offscreen: boolean) {
  const menu = autofillMenuOf(tabId);
  if (menu?.seq === menuSeq && menu.hidden !== offscreen) patchAutofillMenu(tabId, { hidden: offscreen, hovered: offscreen ? false : menu.hovered }, menuSeq);
}

export const activateAutofillRow = (tabId: string, row: AutofillRow) => runAutofillRow(tabId, row, consentToken());

async function runAutofillRow(tabId: string, row: AutofillRow, consent: ConsentToken | null) {
  const menu = autofillMenuOf(tabId);
  if (!menu || menu.busy) return;
  if (row.kind === "manage") {
    const s = useBrowser.getState();
    const profileId = regularProfileId(s.tabs[tabId]?.profileId ?? "");
    closeAutofillMenu(tabId);
    return openSettings("profiles", s.profiles[profileId] ? profileId : null, menu.kind === "card" ? SETTINGS_DETAIL.cards : SETTINGS_DETAIL.addresses);
  }
  patchAutofillMenu(tabId, { busy: row.key, error: null }, menu.seq);
  const id = row.kind === "card" ? row.card.id : row.address.id;
  const result = await fillAutofillEntry(tabId, menu.kind, id).catch(() => null);
  if (autofillMenuOf(tabId)?.seq !== menu.seq) return;
  if (result?.declined) {
    noteCardReauthDeclined(consent);
    return patchAutofillMenu(tabId, { busy: null, error: ERRORS.declined, touch: "off", touchRearms: menu.touchRearms + 1 }, menu.seq);
  }
  if (result?.moved) {
    noteCardFillMoved(consent);
    return closeAutofillMenu(tabId);
  }
  noteAutofillMenuFill(menu.kind, !!result?.filled, consent);
  if (!result?.filled) return patchAutofillMenu(tabId, { busy: null, error: ERRORS.failed }, menu.seq);
  quiet.set(tabId, { kind: menu.kind, until: Date.now() + AFTER_FILL_QUIET_MS });
  closeAutofillMenu(tabId);
}

export function stepAutofillMenu(tabId: string, key: string, consent: ConsentToken | null) {
  const menu = autofillMenuOf(tabId);
  if (!menu) return;
  const rows = autofillRowsOf(menu);
  const step = menuKey(menu.selected, rows.length, key);
  if (step.action === "close") return key === "Escape" ? dismissAutofillMenu(tabId) : closeAutofillMenu(tabId);
  if (step.action === "move") return patchAutofillMenu(tabId, { selected: step.selected });
  if (step.action === "activate") void runAutofillRow(tabId, rows[step.selected]!, consent);
}

export const touchScopeOfAutofill = (tabId: string, row: AutofillRow | undefined) => (isTouchCardRow(row) ? touchScope.card(row.card.id, tabId) : "");

export function armAutofillTouchID(tabId: string, menuSeq: number | null) {
  if (menuSeq !== null) armed = { tabId, seq: menuSeq };
  else if (armed?.tabId === tabId) armed = null;
}

export function noteAutofillTouchStatus(tabId: string, menuSeq: number, status: VaultTouchIDStatus) {
  const menu = autofillMenuOf(tabId);
  if (!menu || menu.seq !== menuSeq) return;
  switch (status) {
    case "ready":
      if (menu.touch === "granted" && menu.busy) return;
      return patchAutofillMenu(tabId, { touch: "ready" }, menuSeq);
    case "retry":
      return patchAutofillMenu(tabId, { touch: "retry", touchRetries: menu.touchRetries + 1 }, menuSeq);
    case "unavailable":
    case "lockout":
      return patchAutofillMenu(tabId, { touch: status }, menuSeq);
    case "granted": {
      const row = autofillRowsOf(menu)[menu.selected];
      if (!armed || armed.tabId !== tabId || armed.seq !== menuSeq || menu.busy || !isTouchCardRow(row)) {
        void dropVaultTouchGrant().catch(() => undefined);
        return patchAutofillMenu(tabId, { touch: "off", touchRearms: menu.touchRearms + 1 }, menuSeq);
      }
      patchAutofillMenu(tabId, { touch: "granted" }, menuSeq);
      return void activateAutofillRow(tabId, row);
    }
  }
}

export function forgetAutofillTab(tabId: string) {
  closeAutofillMenu(tabId);
  claimField(tabId, null);
  quiet.delete(tabId);
  declined.delete(tabId);
  useAutofillMenus.setState((s) => (tabId in s.fields ? { fields: withoutKey(s.fields, tabId) } : s));
}

export function startAutofillMenus() {
  const fields = onAutofillField(noteAutofillField);
  const keys = onAutofillMenuKey((event) => stepAutofillMenu(event.tabId, event.key, nativeConsent(event)));
  const stopTabs = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.windows === prev.windows && s.splits === prev.splits) return;
    const { menus, fields: seen } = useAutofillMenus.getState();
    for (const tabId of new Set([...Object.keys(menus), ...Object.keys(seen)])) if (!(tabId in s.tabs)) forgetAutofillTab(tabId);
    const shown = shownTabIds(s);
    for (const tabId of Object.keys(useAutofillMenus.getState().menus)) if (!shown.has(tabId)) closeAutofillMenu(tabId);
  });
  return () => {
    fields.remove();
    keys.remove();
    stopTabs();
  };
}
