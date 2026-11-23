import { loadedProfiles, onProfileLoaded, unloadIdleProfile } from "../../platform/profiles";
import { everySlowly } from "../../platform/slowTimers";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { hasPage, IDLE, needsPage, wakeOf, withWake, wokenPage } from "../tabs/pageSession";
import { noteProfileKeptForCli, noteProfileUnloaded, noteUnloadedProfileReloaded, noteUnloadedProfileReopened } from "../telemetry/tabSleepCounts";
import { engineProfiles } from "./engineProfiles";
import { consentToken, stillValid } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { idleProfiles, profileUnloadDelay } from "./idleProfiles";
import { markProfileUnloaded, onProfilesOpened, openProfile, profileOpened, shownEngineProfiles } from "./profileLoading";
import { onCliHoldsChanged, tabsHeldByCli } from "../tabs/cliHolds";

const CHECK_MS = 60_000;
const REMOUNT_MS = 100;
const PERSONAL = "";

type Unload = Awaited<ReturnType<typeof unloadIdleProfile>>;

const store = () => useBrowser.getState();
const readyToUnload = idleProfiles();
const unloadedHere = new Set<string>();
const reopenedAt = new Map<string, number>();
const unloadingNow = new Set<string>();
const sleptByUnload = new Set<string>();
let checking = false;
let clock = () => Date.now();

export const profileUnloadingForTests = (now: () => number) => void (clock = now);

function wakeShown(ids: string[]) {
  const s = store();
  const active = new Set(Object.values(s.windows).map((w) => w.activeTabIds[w.profileId]));
  for (const id of ids) {
    const tab = s.tabs[id];
    if (tab && active.has(id) && needsPage(tab)) s.updateTab(id, { page: wokenPage(tab) });
  }
}

export function closedByUnload(tabId: string): boolean {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab) return false;
  if (hasPage(tab)) sleptByUnload.delete(tabId);
  return unloadingNow.has(engineProfile(s, tab.profileId)) || sleptByUnload.has(tabId);
}

const unloadable = (profile: string) => profile !== PERSONAL && !isIncognitoProfile(profile);

function cliHeldEngineProfiles(s: BrowserState): string[] {
  return [...new Set(tabsHeldByCli().flatMap((id) => (s.tabs[id] ? [engineProfile(s, s.tabs[id]!.profileId)] : [])))];
}

const profilesInUse = (s: BrowserState) => new Set([...shownEngineProfiles(s), ...cliHeldEngineProfiles(s)]);

const keptForCli = new Set<string>();

function forgetEndedCliHolds(s: BrowserState) {
  const held = cliHeldEngineProfiles(s);
  for (const profile of keptForCli) if (!held.includes(profile)) keptForCli.delete(profile);
}

function noteKeptForCli(s: BrowserState, consent: ReturnType<typeof consentToken>) {
  forgetEndedCliHolds(s);
  const shown = shownEngineProfiles(s);
  for (const profile of cliHeldEngineProfiles(s)) {
    if (keptForCli.has(profile) || !unloadable(profile) || shown.includes(profile) || !profileOpened(profile) || profileUnloadDelay(s.settings) === null || !stillValid(consent)) continue;
    keptForCli.add(profile);
    noteProfileKeptForCli(consent);
  }
}

function applyUnload(profile: string, result: Unload) {
  const s = store();
  const shown = shownEngineProfiles(s).includes(profile);
  for (const id of result.tabs) {
    const tab = s.tabs[id];
    if (!tab || !hasPage(tab)) continue;
    s.updateTab(id, { page: withWake(IDLE, wakeOf(tab)) });
    sleptByUnload.add(id);
  }
  if (shown) setTimeout(() => wakeShown(result.tabs), REMOUNT_MS);
  if (result.status === "busy") return false;
  if (shown) {
    openProfile(profile);
    return false;
  }
  if (!profileOpened(profile)) return false;
  unloadedHere.add(profile);
  markProfileUnloaded(profile);
  noteProfileUnloaded();
  return true;
}

const SETTLE_MS = 5_000;

async function unload(profile: string, now: number, settled = false): Promise<boolean> {
  const s = store();
  if (!unloadable(profile) || profilesInUse(s).has(profile) || !readyToUnload.due(profile, now, profileUnloadDelay(s.settings))) return false;
  unloadingNow.add(profile);
  try {
    const result = await unloadIdleProfile(profile);
    if (result.heldBy !== "sleeping" || settled) return applyUnload(profile, result);
  } finally {
    unloadingNow.delete(profile);
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return unload(profile, clock(), true);
}

export async function checkIdleProfiles(now = clock()) {
  const s = store();
  const delay = profileUnloadDelay(s.settings);
  if (delay === null) return void readyToUnload([], new Set(), now, null);
  if (checking || engineProfiles(s).length < 2) return;
  checking = true;
  const consent = consentToken();
  try {
    const loaded = (await loadedProfiles()).filter((profile) => unloadable(profile) && profileOpened(profile));
    noteKeptForCli(store(), consent);
    for (const profile of readyToUnload(loaded, profilesInUse(store()), now, delay)) await unload(profile, now);
  } catch (error) {
    warnFor(consent, "[profiles] couldn't unload idle profiles", error);
  } finally {
    checking = false;
  }
}

function watchProfiles(): () => void {
  readyToUnload.noteShown(profilesInUse(store()), clock());
  const shown = useBrowser.subscribeTo(["windows", "profiles"], (s, prev) => {
    if (s.windows !== prev.windows || s.profiles !== prev.profiles) readyToUnload.noteShown(profilesInUse(s), clock());
  });
  const held = onCliHoldsChanged(() => {
    readyToUnload.noteShown(profilesInUse(store()), clock());
    forgetEndedCliHolds(store());
  });
  const opened = onProfilesOpened((engines) => {
    for (const engine of engines) {
      if (!unloadedHere.delete(engine)) continue;
      noteUnloadedProfileReopened();
      reopenedAt.set(engine, Date.now());
    }
  });
  const loaded = onProfileLoaded((engine) => {
    const at = reopenedAt.get(engine);
    if (at === undefined) return;
    reopenedAt.delete(engine);
    noteUnloadedProfileReloaded(Date.now() - at);
  });
  const timer = everySlowly({ every: CHECK_MS, run: () => void checkIdleProfiles() });
  return () => {
    shown();
    held();
    opened();
    loaded.remove();
    timer();
    readyToUnload([], new Set(), 0, null);
  };
}

let started = false;

export function startProfileUnloading() {
  if (started) return;
  started = true;
  let stop: (() => void) | null = null;
  const follow = (on: boolean) => {
    if (on === !!stop) return;
    if (on) stop = watchProfiles();
    else (stop?.(), (stop = null));
  };
  follow(profileUnloadDelay(store().settings) !== null);
  useBrowser.subscribeTo(["settings"], (s, prev) => {
    if (s.settings !== prev.settings) follow(profileUnloadDelay(s.settings) !== null);
  });
  if (__DEV__) (globalThis as { acProfileUnloading?: unknown }).acProfileUnloading = { check: checkIdleProfiles, unload };
}
