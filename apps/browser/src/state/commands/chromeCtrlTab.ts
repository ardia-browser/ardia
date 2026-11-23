import { readDocument, writeDocument } from "../../platform/documents";
import { chromeCtrlTabMru, onProfileLoaded } from "../../platform/profiles";
import { isFields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { noteCtrlTabFollowedChrome } from "../telemetry/settingsPickerCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { ctrlTabChoice, setCtrlTab } from "./commandShortcuts";
import type { CtrlTabChoice, CtrlTabPreset } from "./ctrlTabKeys";

const DOC = "chrome-ctrl-tab.json";
const VERSION = 1;
const FIRST_LOOK_MS = 3000;
const LOOK_AFTER_LEAVING_MS = 15000;
const CHROME_SETTINGS = /^(chrome|ardia):\/\/settings(\/|$|\?|#)/;

type ChromeCtrlTab = Record<string, boolean>;

export function presetFollowingChrome(seen: ChromeCtrlTab, now: ChromeCtrlTab, choice: CtrlTabChoice): CtrlTabPreset | null {
  let wanted: CtrlTabPreset | null = null;
  for (const [profile, mru] of Object.entries(now)) {
    const before = seen[profile];
    if (before === undefined ? mru && choice === "step" : mru !== before) wanted = mru ? "switcher" : "step";
  }
  return wanted && wanted !== choice ? wanted : null;
}

function readSeen(): ChromeCtrlTab {
  let doc: ReturnType<typeof parseSaved> = null;
  try {
    doc = parseSaved(readDocument(DOC), VERSION);
  } catch {
    doc = null;
  }
  const seen: ChromeCtrlTab = {};
  if (doc && isFields(doc.profiles)) for (const [profile, mru] of Object.entries(doc.profiles)) if (typeof mru === "boolean") seen[profile] = mru;
  return seen;
}

function saveSeen(seen: ChromeCtrlTab) {
  try {
    writeDocument(DOC, versionedJson({ profiles: seen }, VERSION));
  } catch {
    return;
  }
}

let looking = false;
let unsupported = false;

async function look(consent: ConsentToken | null) {
  if (looking || unsupported) return;
  looking = true;
  try {
    const choiceBefore = ctrlTabChoice();
    const now = await chromeCtrlTabMru();
    if (!now) {
      unsupported = true;
      return;
    }
    const seen = readSeen();
    const choice = ctrlTabChoice();
    const preset = choice === choiceBefore ? presetFollowingChrome(seen, now, choice) : null;
    if (preset && setCtrlTab(preset)) noteCtrlTabFollowedChrome(preset, consent);
    const merged = { ...seen, ...now };
    if (Object.entries(now).some(([profile, mru]) => seen[profile] !== mru)) saveSeen(merged);
  } catch {
    unsupported = true;
  } finally {
    looking = false;
  }
}

const showsChromeSettings = (s: BrowserState) => Object.keys(s.windows).some((windowId) => CHROME_SETTINGS.test(s.tabs[activeTabId(s, windowId) ?? ""]?.url ?? ""));

let started = false;
let watchShown: ((s: BrowserState) => void) | null = null;

export function chromeCtrlTabStoreChanged(s: BrowserState, prev: BrowserState) {
  if (watchShown && (s.tabs !== prev.tabs || s.windows !== prev.windows)) watchShown(s);
}

export function followChromeCtrlTab() {
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
  watchShown = (s) => watch(showsChromeSettings(s));
}
