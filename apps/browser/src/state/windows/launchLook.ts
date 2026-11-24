import { readDocument, writeDocument } from "../../platform/documents";
import { versionedJson, upgraded, type Migrations } from "../../lib/savedDocument";
import { useBrowser, type BrowserState } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { isPeekTab } from "../peek/peek";
import type { Tab } from "../browser/types";
import { withoutFragment } from "../../lib/url";
import { launchFavicons, seedFavicons, type LaunchFavicons } from "../favicons/launchFavicons";
import { isRegularWindow } from "./small";
import { liveOf, setLive, shownLiveOf } from "../tabs/tabLive";

const DOCUMENT = "launch-look.json";
const VERSION = 2;
const MIGRATIONS: Migrations = {};
const DOCUMENT_LIMIT = 1100 * 1024;
const THEME_LIMIT = 200;
const COLOR_LENGTH_LIMIT = 64;
const RESTORED_THEME_GRACE_MS = 1500;
export const COMMIT_THEME_HOLD_MS = 32;

type RestoredTheme = { tab: string; page: string; color: string };
type LaunchLook = { themes: RestoredTheme[]; favicons: LaunchFavicons };

const holds = new Map<string, { page: string | null; color: string }>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();

function savedTabs(s: BrowserState): Tab[] {
  const windowIds = [...new Set([...s.ui.focusOrder, ...s.windowOrder])];
  return windowIds.flatMap((id) => {
    const w = s.windows[id];
    if (!isRegularWindow(w)) return [];
    return w.tabIds.map((tabId) => s.tabs[tabId]).filter((t): t is Tab => !!t && !!t.url && !isIncognitoProfile(t.profileId) && !isPeekTab(s, t.id));
  });
}

export function saveLaunchLook(s: BrowserState) {
  const tabs = savedTabs(s);
  const themes = tabs
    .flatMap((t) => {
      const color = shownLiveOf(s, t.id).themeColor;
      return color ? [{ tab: t.id, page: withoutFragment(t.url), color }] : [];
    })
    .slice(0, THEME_LIMIT);
  const look: LaunchLook = { themes, favicons: launchFavicons(tabs) };
  const json = versionedJson(look, VERSION);
  try {
    writeDocument(DOCUMENT, json.length <= DOCUMENT_LIMIT ? json : versionedJson({ ...look, favicons: { images: [], profiles: {}, themes: {} } }, VERSION));
  } catch (error) {
    console.warn(`Couldn't save ${DOCUMENT}`, error);
  }
}

function readLaunchLook(): LaunchLook | null {
  try {
    const json = readDocument(DOCUMENT);
    const look = json ? (upgraded(JSON.parse(json), VERSION, MIGRATIONS) as Partial<LaunchLook> | null) : null;
    if (!look || !Array.isArray(look.themes) || !look.favicons || typeof look.favicons !== "object") return null;
    return look as LaunchLook;
  } catch (error) {
    console.warn(`Couldn't read ${DOCUMENT}`, error);
    return null;
  }
}

const isRestoredTheme = (t: unknown): t is RestoredTheme => {
  const r = t as RestoredTheme | null;
  return !!r && typeof r.tab === "string" && typeof r.page === "string" && typeof r.color === "string" && r.color.length <= COLOR_LENGTH_LIMIT;
};

export function restoreLaunchLook() {
  const look = readLaunchLook();
  if (!look) return;
  seedFavicons(look.favicons);
  const s = useBrowser.getState();
  for (const theme of look.themes.filter(isRestoredTheme)) {
    const tab = s.tabs[theme.tab];
    if (!tab || liveOf(theme.tab).themeColor || withoutFragment(tab.url) !== theme.page) continue;
    holds.set(theme.tab, { page: theme.page, color: theme.color });
    setLive(theme.tab, { themeColor: theme.color });
  }
}

const onBlank = (url: string) => !url || url === "about:blank";

function releaseHeldTheme(tabId: string) {
  holds.delete(tabId);
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
}

function settleHeldTheme(tabId: string, after: number) {
  if (settling.has(tabId)) return;
  settling.set(
    tabId,
    setTimeout(() => {
      settling.delete(tabId);
      if (!holds.delete(tabId) || !useBrowser.getState().tabs[tabId]) return;
      useBrowser.getState().updateLive(tabId, { themeColor: null });
    }, after),
  );
}

export function heldThemeColor(tabId: string, url: string, reported: string | null | undefined, isLoading: boolean): string | null {
  const hold = holds.get(tabId);
  if (hold && (reported || (hold.page !== null && !onBlank(url) && withoutFragment(url) !== hold.page))) releaseHeldTheme(tabId);
  else if (hold) {
    if (hold.page !== null && !isLoading && !onBlank(url)) settleHeldTheme(tabId, RESTORED_THEME_GRACE_MS);
    return hold.color;
  }
  if (reported) return reported;
  const shown = liveOf(tabId).themeColor;
  if (!shown) return null;
  holds.set(tabId, { page: null, color: shown });
  settleHeldTheme(tabId, COMMIT_THEME_HOLD_MS);
  return shown;
}


export function endThemeHold(tabId: string) {
  const hold = holds.get(tabId);
  if (!hold || hold.page !== null) return;
  releaseHeldTheme(tabId);
  if (useBrowser.getState().tabs[tabId] && liveOf(tabId).themeColor === hold.color) useBrowser.getState().updateLive(tabId, { themeColor: null });
}

export function hostThemeColor(tabId: string, url: string, reported: string | null | undefined, isLoading: boolean): string | null {
  if (holds.get(tabId)?.page) releaseHeldTheme(tabId);
  return heldThemeColor(tabId, url, reported, isLoading);
}

export function holdThemeColor(tabId: string) {
  const shown = hostThemeColor(tabId, "", null, true);
  if (liveOf(tabId).themeColor !== shown) useBrowser.getState().updateLive(tabId, { themeColor: shown });
}
