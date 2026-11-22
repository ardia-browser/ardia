import { readDocument, removeDocument, writeDocument } from "../../platform/documents";
import { chromeProfilePrefs, onProfileLoaded } from "../../platform/profiles";
import { isFields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import type { Settings } from "../settings/settings";
import { setShortcutOverride } from "../settings/actions";
import { noteChromeSwitchFollowed, noteCtrlTabFollowedChrome, type FollowedChromeSwitch } from "../telemetry/settingsPickerCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { ctrlTabChoice, resolvedShortcuts, setCtrlTab } from "./commandShortcuts";
import { comboKey, storedShortcut, type ResolvedShortcuts, type Shortcut, type ShortcutOverrides } from "./shortcuts";
import type { CtrlTabChoice, CtrlTabPreset } from "./ctrlTabKeys";

const DOC = "chrome-switches.json";
const CTRL_TAB_DOC = "chrome-ctrl-tab.json";
const VERSION = 1;
const FIRST_LOOK_MS = 3000;
const LOOK_AFTER_LEAVING_MS = 15000;
const CHROME_SETTINGS = /^(chrome|ardia):\/\/settings(\/|$|\?|#)/;

export type ChromeSwitch = "ctrlTab" | FollowedChromeSwitch;

export const CHROME_SWITCHES: Readonly<Record<ChromeSwitch, { pref: string; chromeDefault: boolean }>> = {
  ctrlTab: { pref: "helium.browser.mru_tab_cycling", chromeDefault: false },
  newTabs: { pref: "helium.browser.new_tab_next_to_active", chromeDefault: false },
  hideTabsKey: { pref: "helium.settings.behavior.vertical_collapse_shortcut", chromeDefault: true },
};

const SWITCHES = Object.keys(CHROME_SWITCHES) as ChromeSwitch[];
const PREFS = SWITCHES.map((name) => CHROME_SWITCHES[name].pref);

export type ChromePrefs = Record<string, Record<string, boolean>>;
export type SwitchChange = { on: boolean; firstLook: boolean };

export function switchChanges(seen: ChromePrefs, now: ChromePrefs): Partial<Record<ChromeSwitch, SwitchChange>> {
  const changes: Partial<Record<ChromeSwitch, SwitchChange>> = {};
  for (const [profile, values] of Object.entries(now)) {
    for (const name of SWITCHES) {
      const { pref, chromeDefault } = CHROME_SWITCHES[name];
      const on = values[pref] ?? chromeDefault;
      const before = seen[profile]?.[pref];
      if (before === undefined ? on !== chromeDefault : on !== before) changes[name] = { on, firstLook: before === undefined };
    }
  }
  return changes;
}

export function withChromeDefaults(values: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(SWITCHES.map((name) => [CHROME_SWITCHES[name].pref, values[CHROME_SWITCHES[name].pref] ?? CHROME_SWITCHES[name].chromeDefault]));
}

export function ctrlTabPresetFollowing({ on, firstLook }: SwitchChange, choice: CtrlTabChoice): CtrlTabPreset | null {
  const wanted: CtrlTabPreset = on ? "switcher" : "step";
  if (wanted === choice || (firstLook && choice !== "step")) return null;
  return wanted;
}

type NewTabSettings = Pick<Settings, "newTabPosition" | "newTabButtonPosition">;

export function newTabPositionFollowing({ on, firstLook }: SwitchChange, settings: NewTabSettings): Settings["newTabPosition"] | null {
  const position = settings.newTabPosition;
  if (!on) return position === "nextToCurrent" ? settings.newTabButtonPosition : null;
  if (position === "nextToCurrent" || (firstLook && position !== "bottom")) return null;
  return "nextToCurrent";
}

const COLLAPSE_KEY = "s";

export function hideTabsKeysOf(resolved: Pick<ResolvedShortcuts, "defaultsOf">): { collapse: Shortcut; kept: Shortcut } | null {
  const defaults = resolved.defaultsOf("toggleSidebar");
  const collapse = defaults.find((k) => k.key === COLLAPSE_KEY && k.modifiers.length === 1);
  const kept = defaults.find((k) => k !== collapse);
  return collapse && kept ? { collapse, kept } : null;
}

export function hideTabsKeyFollowing({ on }: SwitchChange, overrides: ShortcutOverrides, resolved: Pick<ResolvedShortcuts, "defaultsOf">): Shortcut | null | undefined {
  const keys = hideTabsKeysOf(resolved);
  if (!keys) return undefined;
  const stored = overrides.toggleSidebar;
  if (on) return stored?.[0] && comboKey(storedShortcut(stored)) === comboKey(keys.kept) ? null : undefined;
  return stored === undefined ? keys.kept : undefined;
}

function prefsFrom(doc: ReturnType<typeof parseSaved>, read: (value: unknown) => Record<string, boolean> | null): ChromePrefs {
  const prefs: ChromePrefs = {};
  if (doc && isFields(doc.profiles)) {
    for (const [profile, value] of Object.entries(doc.profiles)) {
      const values = read(value);
      if (values) prefs[profile] = values;
    }
  }
  return prefs;
}

const booleansOf = (value: unknown): Record<string, boolean> | null =>
  isFields(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : null;

function parsedDoc(name: string): ReturnType<typeof parseSaved> {
  try {
    return parseSaved(readDocument(name), VERSION);
  } catch {
    return null;
  }
}

function readSeen(): ChromePrefs {
  const doc = parsedDoc(DOC);
  if (doc) return prefsFrom(doc, booleansOf);
  return prefsFrom(parsedDoc(CTRL_TAB_DOC), (mru) => (typeof mru === "boolean" ? { [CHROME_SWITCHES.ctrlTab.pref]: mru } : null));
}

function saveSeen(seen: ChromePrefs) {
  try {
    writeDocument(DOC, versionedJson({ profiles: seen }, VERSION));
    removeDocument(CTRL_TAB_DOC);
  } catch {
    return;
  }
}

type Followed = Pick<Settings, "shortcuts" | "newTabPosition" | "newTabButtonPosition">;
const followedOf = ({ settings: { shortcuts, newTabPosition, newTabButtonPosition } }: BrowserState): Followed => ({ shortcuts, newTabPosition, newTabButtonPosition });
const sameFollowed = (a: Followed, b: Followed) => (Object.keys(a) as (keyof Followed)[]).every((key) => a[key] === b[key]);

function follow(name: ChromeSwitch, change: SwitchChange, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const noted = (applied: boolean) => {
    if (applied && name !== "ctrlTab") noteChromeSwitchFollowed(name, change.on, consent);
  };
  switch (name) {
    case "ctrlTab": {
      const preset = ctrlTabPresetFollowing(change, ctrlTabChoice(s));
      if (preset && setCtrlTab(preset)) noteCtrlTabFollowedChrome(preset, consent);
      return;
    }
    case "newTabs": {
      const position = newTabPositionFollowing(change, s.settings);
      if (position) s.updateSettings({ newTabPosition: position });
      return noted(!!position);
    }
    case "hideTabsKey": {
      const shortcut = hideTabsKeyFollowing(change, s.settings.shortcuts, resolvedShortcuts(s));
      if (shortcut !== undefined) setShortcutOverride("toggleSidebar", shortcut);
      return noted(shortcut !== undefined);
    }
  }
}

let looking = false;
let unsupported = false;

async function look(consent: ConsentToken | null) {
  if (looking || unsupported) return;
  looking = true;
  try {
    const before = followedOf(useBrowser.getState());
    const now = await chromeProfilePrefs(PREFS);
    if (!now) {
      unsupported = true;
      return;
    }
    const filled: ChromePrefs = Object.fromEntries(Object.entries(now).map(([profile, values]) => [profile, withChromeDefaults(values)]));
    const seen = readSeen();
    if (sameFollowed(before, followedOf(useBrowser.getState()))) {
      for (const [name, change] of Object.entries(switchChanges(seen, filled)) as [ChromeSwitch, SwitchChange][]) follow(name, change, consent);
    }
    const changed = Object.entries(filled).some(([profile, values]) => PREFS.some((pref) => seen[profile]?.[pref] !== values[pref]));
    if (changed) saveSeen({ ...seen, ...filled });
  } catch {
    unsupported = true;
  } finally {
    looking = false;
  }
}

const showsChromeSettings = (s: BrowserState) => Object.keys(s.windows).some((windowId) => CHROME_SETTINGS.test(s.tabs[activeTabId(s, windowId) ?? ""]?.url ?? ""));

let started = false;

export function followChromeSwitches() {
  if (started) return;
  started = true;
  const consent = consentToken();
  let shown = false;
  let lookAfterLeaving: ReturnType<typeof setTimeout> | undefined;
  const watch = (now: boolean) => {
    if (now === shown || unsupported) return;
    shown = now;
    clearTimeout(lookAfterLeaving);
    if (!shown) lookAfterLeaving = setTimeout(() => void look(consent), LOOK_AFTER_LEAVING_MS);
  };
  let launched = false;
  setTimeout(() => {
    launched = true;
    void look(consent);
    shown = showsChromeSettings(useBrowser.getState());
  }, FIRST_LOOK_MS);
  onProfileLoaded(() => void (launched && look(consent)));
  useBrowser.subscribeTo(["tabs", "windows"], (s, prev) => {
    if (s.tabs !== prev.tabs || s.windows !== prev.windows) watch(showsChromeSettings(s));
  });
}
