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

type SettingsStop = SettingsPlace & { scroll: number; visit: number; shownProfile: string | null };

type Nav = SettingsStop & { back: SettingsStop[]; forward: SettingsStop[] };

export const settingsPlaceKey = (s: SettingsPlace) => `${s.pane}:${s.profileId ?? ""}:${s.detail ?? ""}`;

export const settingsPageKey = (s: SettingsPlace) => (s.pane === "profiles" && !s.detail ? "profiles::" : settingsPlaceKey(s));

export function shownSettingsProfile(s: SettingsPlace): string | null {
  if (s.pane !== "profiles") return s.profileId;
  const { profiles, settings } = useBrowser.getState();
  return s.profileId && profiles[s.profileId] ? s.profileId : settings.defaultProfileId;
}

const shownPlaceKey = (s: SettingsPlace) => settingsPlaceKey({ ...s, profileId: shownSettingsProfile(s) });

let lastVisit = 0;
export const newSettingsVisit = () => ++lastVisit;

let shownOffset: { visit: number; y: number; shownProfile: string | null } = { visit: -1, y: 0, shownProfile: null };

export function rememberSettingsScrollOffset(visit: number, y: number) {
  const nav = useSettingsNav.getState();
  if (visit === nav.visit) shownOffset = { visit, y, shownProfile: shownSettingsProfile(nav) };
}

const stopOf = (s: SettingsStop): SettingsStop =>
  shownOffset.visit === s.visit
    ? { pane: s.pane, profileId: s.profileId, detail: s.detail, visit: s.visit, shownProfile: shownOffset.shownProfile, scroll: shownOffset.y }
    : { pane: s.pane, profileId: s.profileId, detail: s.detail, visit: s.visit, shownProfile: s.shownProfile, scroll: s.scroll };

export const useSettingsNav = create<Nav>()(() => ({ pane: "general", profileId: null, detail: null, scroll: 0, visit: newSettingsVisit(), shownProfile: null, back: [], forward: [] }));

export function goToSettingsPane(pane: SettingsPane, profileId: string | null = null, detail: string | null = null) {
  const current = useSettingsNav.getState();
  if (current.pane === pane && current.profileId === profileId && current.detail === detail) return;
  useSettingsNav.setState({ pane, profileId, detail, scroll: 0, visit: newSettingsVisit(), shownProfile: shownSettingsProfile({ pane, profileId, detail }), back: [...current.back, stopOf(current)].slice(-30), forward: [] });
}

const replacedOffsets = new Map<string, number>();

function leftPlaceKey(stop: SettingsStop): string | null {
  if (stop.pane !== "profiles") return settingsPlaceKey(stop);
  return stop.shownProfile && useBrowser.getState().profiles[stop.shownProfile] ? settingsPlaceKey({ ...stop, profileId: stop.shownProfile }) : null;
}

export function replaceSettingsPlace(profileId: string | null, detail: string | null = null) {
  const current = useSettingsNav.getState();
  const { pane, back } = current;
  const left = stopOf(current);
  const leaving = leftPlaceKey(left);
  if (leaving) replacedOffsets.set(leaving, left.scroll);
  const prev = back.at(-1);
  const same = prev?.pane === pane && prev.profileId === profileId && prev.detail === detail;
  const place = { pane, profileId, detail };
  const stop = same
    ? { scroll: prev.scroll, visit: prev.visit, shownProfile: prev.shownProfile }
    : { scroll: replacedOffsets.get(shownPlaceKey(place)) ?? 0, visit: newSettingsVisit(), shownProfile: shownSettingsProfile(place) };
  useSettingsNav.setState({ profileId, detail, ...stop, back: same ? back.slice(0, -1) : back, forward: [] });
}

export function settingsBack() {
  const current = useSettingsNav.getState();
  const prev = current.back.at(-1);
  if (prev) useSettingsNav.setState({ ...prev, back: current.back.slice(0, -1), forward: [stopOf(current), ...current.forward] });
}

export function settingsForward() {
  const current = useSettingsNav.getState();
  const next = current.forward[0];
  if (next) useSettingsNav.setState({ ...next, forward: current.forward.slice(1), back: [...current.back, stopOf(current)] });
}

const atTop = (s: SettingsStop): SettingsStop => ({ ...s, scroll: 0 });

export function forgetSettingsScroll() {
  const { back, forward } = useSettingsNav.getState();
  shownOffset = { visit: -1, y: 0, shownProfile: null };
  replacedOffsets.clear();
  useSettingsNav.setState({ scroll: 0, back: back.map(atTop), forward: forward.map(atTop) });
}

export function settingsScrollFor(visit: number) {
  const nav = useSettingsNav.getState();
  return nav.visit === visit && nav.shownProfile === shownSettingsProfile(nav) ? nav.scroll : 0;
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

const targetedOpenListeners = new Set<(consent: ConsentToken | null, reveal: string | null) => void>();
const openListeners = new Set<(pane: SettingsPane, profileId: string | null) => void>();
let pendingOpenAt: number | null = null;
const OPEN_CLAIM_MS = 5_000;

export const onTargetedSettingsOpen = (listener: (consent: ConsentToken | null, reveal: string | null) => void) => void targetedOpenListeners.add(listener);
export const onSettingsOpen = (listener: (pane: SettingsPane, profileId: string | null) => void) => void openListeners.add(listener);
export function claimSettingsOpenAt(): number | null {
  const at = pendingOpenAt;
  pendingOpenAt = null;
  return at !== null && Date.now() - at < OPEN_CLAIM_MS ? at : null;
}

export function openSettings(pane?: SettingsPane, profileId?: string | null, detail?: string | null, reveal?: string | null) {
  if (pane) {
    const consent = consentToken();
    goToSettingsPane(pane, profileId ?? null, detail ?? null);
    targetedOpenListeners.forEach((listener) => listener(consent, reveal ?? null));
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

export function openUrlFromSettings(url: string): boolean {
  const windowId = settingsBrowserWindow();
  if (!windowId) return false;
  useBrowser.getState().newTab(windowId, { url });
  void focusWindow(windowId);
  return true;
}
