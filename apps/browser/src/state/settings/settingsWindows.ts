import { focusWindow, openWindow } from "../../platform/windows";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";

export const SETTINGS_WINDOW_ID = "settings";
export const IMPORT_WINDOW_ID = "import";

export const isUtilityWindowId = (id: string | null | undefined) =>
  id === SETTINGS_WINDOW_ID || id === IMPORT_WINDOW_ID;

export const SETTINGS_PANES = ["general", "profiles", "tabs", "appearance", "automations", "plugins", "shortcuts", "advanced"] as const;

export type SettingsPane = (typeof SETTINGS_PANES)[number];


export type SettingsPlace = { pane: SettingsPane; profileId: string | null; detail: string | null };

type Nav = SettingsPlace & { back: SettingsPlace[]; forward: SettingsPlace[] };

const placeOf = ({ pane, profileId, detail }: SettingsPlace): SettingsPlace => ({ pane, profileId, detail });

export const useSettingsNav = create<Nav>()(() => ({ pane: "general", profileId: null, detail: null, back: [], forward: [] }));

export function goToSettingsPane(pane: SettingsPane, profileId: string | null = null, detail: string | null = null) {
  const current = useSettingsNav.getState();
  if (current.pane === pane && current.profileId === profileId && current.detail === detail) return;
  useSettingsNav.setState({ pane, profileId, detail, back: [...current.back, placeOf(current)].slice(-30), forward: [] });
}

export function replaceSettingsPlace(profileId: string | null, detail: string | null = null) {
  const { pane, back } = useSettingsNav.getState();
  const prev = back.at(-1);
  const same = prev?.pane === pane && prev.profileId === profileId && prev.detail === detail;
  useSettingsNav.setState({ profileId, detail, back: same ? back.slice(0, -1) : back, forward: [] });
}

export function settingsBack() {
  const current = useSettingsNav.getState();
  const prev = current.back.at(-1);
  if (prev) useSettingsNav.setState({ ...prev, back: current.back.slice(0, -1), forward: [placeOf(current), ...current.forward] });
}

export function settingsForward() {
  const current = useSettingsNav.getState();
  const next = current.forward[0];
  if (next) useSettingsNav.setState({ ...next, forward: current.forward.slice(1), back: [...current.back, placeOf(current)] });
}

export const SETTINGS_DETAIL = {
  filterLists: "filterLists",
  crashDetails: "crashDetails",
  sites: "sites",
  passwords: "passwords",
  addresses: "addresses",
  cards: "cards",
  otherEngines: "otherEngines",
  site: (origin: string) => `site:${origin}`,
  extension: (id: string) => `extension:${id}`,
} as const;

export const detailValue = (detail: string | null, kind: "site" | "extension") => (detail?.startsWith(`${kind}:`) ? detail.slice(kind.length + 1) : null);

const targetedOpenListeners = new Set<(consent: ConsentToken | null) => void>();
const openListeners = new Set<(pane: SettingsPane, profileId: string | null) => void>();
let pendingOpenAt: number | null = null;
const OPEN_CLAIM_MS = 5_000;

export const onTargetedSettingsOpen = (listener: (consent: ConsentToken | null) => void) => void targetedOpenListeners.add(listener);
export const onSettingsOpen = (listener: (pane: SettingsPane, profileId: string | null) => void) => void openListeners.add(listener);
export function claimSettingsOpenAt(): number | null {
  const at = pendingOpenAt;
  pendingOpenAt = null;
  return at !== null && Date.now() - at < OPEN_CLAIM_MS ? at : null;
}

export function openSettings(pane?: SettingsPane, profileId?: string | null, detail?: string | null) {
  if (pane) {
    const consent = consentToken();
    targetedOpenListeners.forEach((listener) => listener(consent));
    goToSettingsPane(pane, profileId ?? null, detail ?? null);
  }
  const nav = useSettingsNav.getState();
  pendingOpenAt = Date.now();
  void openWindow(SETTINGS_WINDOW_ID, { kind: "settings", title: "Settings" });
  openListeners.forEach((listener) => listener(nav.pane, nav.profileId));
}

export const openSiteSettings = (origin: string, profileId: string) => openSettings("profiles", profileId, SETTINGS_DETAIL.site(origin));

const useImportRequest = create<{ source: string | null }>()(() => ({ source: null }));

export function takePreferredImportSource() {
  const { source } = useImportRequest.getState();
  useImportRequest.setState({ source: null });
  return source;
}

export function openImport(browserId?: string) {
  useImportRequest.setState({ source: browserId ?? null });
  void openWindow(IMPORT_WINDOW_ID, { kind: "import", title: "Import from Another Browser" });
}

export function settingsBrowserWindow(): string | null {
  const s = useBrowser.getState();
  return s.ui.focusOrder.find((id) => s.windows[id] && s.windows[id]!.kind !== "private") ?? s.windowOrder.find((id) => s.windows[id]!.kind !== "private") ?? null;
}

export function openUrlFromSettings(url: string) {
  const windowId = settingsBrowserWindow();
  if (!windowId) return;
  useBrowser.getState().newTab(windowId, { url });
  void focusWindow(windowId);
}
