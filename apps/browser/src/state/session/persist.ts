import { createDocument, documentSaved, writeDocument } from "../../platform/documents";
import { SESSION_DOCUMENT } from "./sessionDocument";
import { cosmeticChange, doc, field, listed, type Doc } from "./documentJson";
import { useBrowser, type BrowserState } from "../browser/store";
import { isIncognitoProfile, tabsShownIn } from "../browser/model";
import { earlyLaunchTabOn, launchTab, linkProfile } from "../tabs/launchTab";
import { launchBackdrop } from "../windows/launchBackdrop";
import { restoreLaunchLook, saveLaunchLook } from "../windows/launchLook";
import { isPeekTab } from "../peek/peek";
import type { Tab } from "../browser/types";
import { downloadSession } from "../downloads/downloadsSlice";
import { anyDownloadProgress, withLiveProgress } from "../downloads/progress";
import { noteDownloadHistoryWrite } from "../telemetry/downloadWork";
import { noteSessionBackup, noteSessionFromOtherShell, noteSessionSetAside, noteSessionSetAsideFailure, noteSessionWrite, timeSessionSave } from "../telemetry/sessionWrites";
import { saveBeforeQuit } from "../app/quit";
import { landHeldPins, pinGuard, savedAfterPins } from "./pinGuard";
import { fromNewerBuild, keepAsideGate, rollingBackups, writeGate, type WriteGate } from "./sessionSafety";
import { consentToken } from "../telemetry/consentPeriod";
import { isRegularWindow } from "../windows/small";
import { savedPage } from "./savedShapes";
import { SESSION_VERSION } from "./savedSession";
import { parseSettingsMeta } from "../settings/settings";
import { retiredDefaultsAppliedSince } from "../settings/retiredDefaults";
import { DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, hydrateAtLaunch, OLDER_BUILD_SESSION_DOCUMENT, wholeBackup, type LaunchOverrides } from "./launchSession";

export { parseSession, SESSION_MIGRATIONS, SESSION_VERSION } from "./savedSession";

export { loadSession } from "./launchSession";

const SAVE_DELAY_MS = 800;
const COSMETIC_SAVE_DELAY_MS = 10_000;
const publicTab = (t: { profileId: string }) => !isIncognitoProfile(t.profileId);
const publicProfiles = <T,>(byProfile: Record<string, T>) => Object.fromEntries(Object.entries(byProfile).filter(([profileId]) => publicTab({ profileId })));

const persistedTab = (t: Tab) => ({ ...t, page: savedPage(t) });
const savedWindows = (s: Pick<BrowserState, "windows">) =>
  Object.values(s.windows).filter(isRegularWindow).map(({ chromeWindow: _c, kind: _k, ...w }) => ({ ...w, incognito: false }));
const savedWindowsWithTabsShown = (s: Pick<BrowserState, "windows" | "settings">) => savedWindows(s).map((w) => ({ ...w, sidebarOpen: tabsShownIn(s, w.id) }));
const savedWindowIds = (s: Pick<BrowserState, "windows">) => new Set(savedWindows(s).map((w) => w.id));
const savedFocus = (s: Pick<BrowserState, "windows" | "ui">) => {
  const kept = savedWindowIds(s);
  return s.ui.focusOrder.find((id) => kept.has(id)) ?? null;
};

const SESSION_FIELDS = {
  profiles: field(["profiles"], (s) => s.profiles),
  profileOrder: field(["profileOrder"], (s) => s.profileOrder),
  orphanedProfileData: field(["orphanedProfileData"], (s) => s.orphanedProfileData),
  settings: field(["settings"], (s) => s.settings),
  settingsMeta: field(["settingsMeta"], (s) => s.settingsMeta),
  windows: field(["windows", "settings"], savedWindowsWithTabsShown),
  windowOrder: field(["windows", "windowOrder"], (s) => {
    const kept = savedWindowIds(s);
    return s.windowOrder.filter((id) => kept.has(id));
  }),
  focusedWindowId: field(["windows", "ui"], savedFocus),
  lastProfileId: field(["ui"], (s) => s.ui.lastProfileId),
  launchTab: field(["windows", "tabs", "settings", "profiles", "ui"], (s) => (earlyLaunchTabOn() ? launchTab(s, savedFocus(s)) : null)),
  launchBackdrop: field(["windows", "profiles", "ui", "settings"], (s) => (earlyLaunchTabOn() ? launchBackdrop(s, savedFocus(s)) : null)),
  linkProfile: field(["windows", "profiles", "ui", "windowOrder", "settings"], (s) => (earlyLaunchTabOn() ? linkProfile(s) : null)),
  tabs: field(["windows", "tabs", "peeks"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.tabs).filter((t) => kept.has(t.windowId) && !isPeekTab(s, t.id)), persistedTab);
  }),
  groups: field(["windows", "groups"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.groups).filter((g) => kept.has(g.windowId)));
  }),
  splits: field(["windows", "splits"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.splits).filter((v) => kept.has(v.windowId)));
  }),
  closedTabs: field(["closedTabs"], (s) => listed(s.closedTabs.filter((c) => publicTab(c.tab)))),
  closedWindows: field(["closedWindows", "settings"], (s) =>
    s.closedWindows.filter((c) => c.tabs.every(publicTab)).map((c) => ({ ...c, window: { ...c.window, sidebarOpen: !(c.window.autoHideTabs ?? s.settings.autoHideTabs) } })),
  ),
  parkedPins: field(["parkedPins"], (s) => publicProfiles(s.parkedPins)),
  pinChoices: field(["pinChoices"], (s) => publicProfiles(s.pinChoices)),
  pinSync: field(["pinSync"], (s) => publicProfiles(s.pinSync)),
  topAppsMerged: field(["topAppsMerged"], (s) => s.topAppsMerged),
  closedGroups: field(["closedGroups"], (s) => s.closedGroups.filter((c) => c.tabs.every(publicTab))),
  deletedGroups: field(["deletedGroups"], (s) => s.deletedGroups.filter((c) => c.tabs.every(publicTab))),
  cleanedTabs: field(["cleanedTabs"], (s) => s.cleanedTabs.filter((c) => publicTab(c.tab))),
};

const DOWNLOADS_FIELDS = {
  downloads: field(["downloads", "profiles"], (s) =>
    withLiveProgress(s.downloads.filter((d) => downloadSession(s, d) === null)).map((d) => (d.state === "downloading" ? { ...d, state: "failed" } : d)),
  ),
};

const DOCS: Doc[] = [doc(DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, DOWNLOADS_FIELDS), doc(SESSION_DOCUMENT, SESSION_VERSION, SESSION_FIELDS)];

let sessionFile = SESSION_DOCUMENT;

function write(name: string, json: string): boolean {
  try {
    writeDocument(name, json);
    return true;
  } catch (error) {
    console.warn(`Couldn't save ${name}`, error);
    return false;
  }
}

let flush: () => void = () => {};
let unstaged: () => boolean = () => false;
let pinsLanding: () => Promise<void> | null = () => null;
let resume: () => void = () => {};
let stageDownloads: () => void = () => {};
let frozen = false;
let sessionGated: () => boolean = () => false;

export const sessionWritesBlocked = () => sessionGated();

export function flushPersistence({ final = false } = {}): boolean {
  const saving = !frozen;
  if (final && anyDownloadProgress()) stageDownloads();
  flush();
  if (final && !frozen) saveLaunchLook(useBrowser.getState());
  if (final) frozen = true;
  return saving;
}

export async function sessionSaved(): Promise<boolean> {
  if (!(await savedAfterPins(flushPersistence, unstaged, pinsLanding))) return false;
  try {
    await documentSaved(sessionFile);
    return !frozen;
  } catch {
    return false;
  }
}

export function holdPersistence(): boolean {
  const saving = flushPersistence();
  frozen = true;
  return saving;
}

export function resumePersistence() {
  frozen = false;
  resume();
}

let restoredAtLaunch = false;
let realignedAtLaunch = 0;

export const sessionRestoredAtLaunch = () => restoredAtLaunch;
export const windowsRealignedToAutoHideTabsAtLaunch = () => realignedAtLaunch;

export function startPersistence(overrides: LaunchOverrides = {}) {
  const launch = hydrateAtLaunch(overrides);
  const loaded = launch.loaded;
  const newerSessionKept = fromNewerBuild(launch.session);
  const ownSessionFile = newerSessionKept ? OLDER_BUILD_SESSION_DOCUMENT : SESSION_DOCUMENT;
  const fileOf = (name: string) => (name === SESSION_DOCUMENT ? ownSessionFile : name);
  sessionFile = ownSessionFile;
  let stopped = false;
  let signalStopped: () => void = () => {};
  const whenStopped = new Promise<void>((resolve) => (signalStopped = resolve));
  const consent = consentToken();
  if (launch.session.state === "unusable") noteSessionSetAside(true, launch.session.reason, launch.restored?.ageDays ?? null, consent);
  if (launch.downloads.state === "unusable") noteSessionSetAside(false, launch.downloads.reason, null, consent);
  if (launch.rowTables) noteSessionFromOtherShell(consent);
  restoredAtLaunch = !!loaded?.windowOrder?.length;
  realignedAtLaunch = loaded?.windowsAgainstAutoHideTabs ?? 0;
  const retiredDefaultsApplied = launch.session.state === "usable" && !!loaded && retiredDefaultsAppliedSince({ settings: loaded.settings, settingsMeta: parseSettingsMeta(loaded.settingsMeta) }, useBrowser.getState());
  restoreLaunchLook();

  const keepDroppedPins = pinGuard(useBrowser.getState(), (delay) => unstaged() && schedule(delay));
  const gates = new Map<string, WriteGate>();
  const recovering = launch.session.state === "unusable" || launch.session.state === "unknown";
  const backups = rollingBackups({ whole: wholeBackup, recovering: () => recovering, written: noteSessionBackup });
  pinsLanding = () => gates.get(SESSION_DOCUMENT)?.landing() ?? keepDroppedPins.landing();
  sessionGated = () => !(gates.get(SESSION_DOCUMENT)?.open() ?? true);
  const anyLanding = () => [...gates.values()].map((g) => g.landing()).find((l) => l !== null) ?? keepDroppedPins.landing();
  const stopSavingBeforeQuit = saveBeforeQuit(async () => {
    if (stopped) return;
    for (const gate of gates.values()) gate.tryNow();
    const landingUntilStopped = () => {
      const landing = anyLanding();
      return landing && Promise.race([landing, whenStopped]);
    };
    return landHeldPins(() => !stopped && dirty.size > 0 && frozen, landingUntilStopped, () => ((frozen = false), save(), (frozen = true)));
  });
  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = 0;
  let cosmeticOnly = true;

  const schedule = (delay: number) => {
    if (stopped) return;
    const at = Date.now() + delay;
    if (timer !== undefined && due <= at) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(save, delay);
  };

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frozen || stopped) return;
    const s = useBrowser.getState();
    const done = timeSessionSave();
    const held = new Set<string>();
    let againIn: number | null = null;
    const holdFor = (wait: number | null) => {
      if (wait !== null) againIn = againIn === null ? wait : Math.min(againIn, wait);
    };
    for (const gate of gates.values()) {
      const waiting = gate.check();
      if (waiting.hold) holdFor(waiting.againIn);
    }
    for (const doc of DOCS.filter((d) => dirty.has(d))) {
      if (doc.name === SESSION_DOCUMENT) done.sessionStarts();
      const gate = gates.get(doc.name)?.check();
      if (gate?.hold) {
        held.add(doc.name);
        holdFor(gate.againIn);
        continue;
      }
      const json = doc.json(s);
      const saved = lastJson.get(doc.name) === json;
      const pins = !saved && doc.name === SESSION_DOCUMENT ? keepDroppedPins(s) : null;
      if (pins?.hold) {
        held.add(doc.name);
        holdFor(pins.againIn);
        continue;
      }
      if (saved || write(fileOf(doc.name), json)) {
        pins?.commit();
        if (!saved && doc.name === DOWNLOADS_DOCUMENT) noteDownloadHistoryWrite(json.length);
        if (!saved && doc.name === SESSION_DOCUMENT) {
          noteSessionWrite(json.length, cosmeticOnly);
          if (!newerSessionKept) backups.afterSave(json);
        }
        lastJson.set(doc.name, json);
        dirty.delete(doc);
      }
    }
    done();
    if (!held.has(SESSION_DOCUMENT)) cosmeticOnly = true;
    if ([...dirty].some((d) => !held.has(d.name))) schedule(SAVE_DELAY_MS);
    if (againIn !== null) schedule(againIn);
  };
  flush = save;
  stageDownloads = () => dirty.add(DOCS.find((d) => d.name === DOWNLOADS_DOCUMENT)!);
  unstaged = () => [...dirty].some((d) => d.name === SESSION_DOCUMENT);

  const check = (s: BrowserState, initial = false) => {
    if (frozen) return;
    let urgent = false;
    for (const doc of DOCS) {
      const sources = doc.reads.map((key) => s[key]);
      const prev = lastSources.get(doc.name);
      if (prev && sources.every((v, i) => v === prev[i])) continue;
      lastSources.set(doc.name, sources);
      if (initial) continue;
      dirty.add(doc);
      if (!prev || !cosmeticChange(doc, prev, sources)) urgent = true;
    }
    if (urgent) cosmeticOnly = false;
    if (dirty.size) schedule(urgent || !cosmeticOnly ? SAVE_DELAY_MS : COSMETIC_SAVE_DELAY_MS);
  };
  const sessionFound = newerSessionKept ? (launch.olderBuild ?? { state: "missing" as const }) : launch.session;
  for (const [name, found] of [[SESSION_DOCUMENT, sessionFound], [DOWNLOADS_DOCUMENT, launch.downloads]] as const) {
    const session = name === SESSION_DOCUMENT;
    const file = fileOf(name);
    const gate = keepAsideGate(file, found, (delay) => schedule(delay), { unreadable: () => noteSessionSetAside(session, "unreadable", null, consent), failed: () => noteSessionSetAsideFailure(session, consent) }, async () => {
      if (stopped) return;
      await createDocument(file, DOCS.find((d) => d.name === name)!.json(useBrowser.getState()));
    });
    if (gate) gates.set(name, gate);
  }
  if (launch.session.state === "usable" && launch.session.from < SESSION_VERSION) {
    const old = launch.session.text;
    gates.set(SESSION_DOCUMENT, writeGate(() => backups.beforeMigration(old), (delay) => schedule(delay)));
  }
  check(useBrowser.getState(), true);
  if (launch.session.state === "unusable" || launch.session.state === "unknown") {
    dirty.add(DOCS.find((d) => d.name === SESSION_DOCUMENT)!);
    cosmeticOnly = false;
  }
  if (launch.droppedPrivateDownloads) {
    dirty.add(DOCS.find((d) => d.name === DOWNLOADS_DOCUMENT)!);
    cosmeticOnly = false;
    schedule(SAVE_DELAY_MS);
  }
  if (realignedAtLaunch || retiredDefaultsApplied || (launch.rowTables && launch.session.state === "usable")) {
    dirty.add(DOCS.find((d) => d.name === SESSION_DOCUMENT)!);
    cosmeticOnly = false;
    schedule(SAVE_DELAY_MS);
  }
  resume = () => {
    check(useBrowser.getState());
    save();
  };
  const unsubscribe = useBrowser.subscribe((s) => check(s));
  return () => {
    stopped = true;
    signalStopped();
    stopSavingBeforeQuit();
    clearTimeout(timer);
    timer = undefined;
    unsubscribe();
  };
}
