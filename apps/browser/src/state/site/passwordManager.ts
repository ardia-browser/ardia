import { setFieldProviders, showSystemPanel, type FieldProviderHint, type FieldProviderOpened, type VerificationCodeFound } from "../../platform/passwordProviders";
import { offerPanelHint, panelHintReported } from "./panelHints";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { warnFor } from "../telemetry/consoleConsent";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { usePages } from "../tabs/pageState";
import { useShallow } from "zustand/react/shallow";
import { beforePluginsCommit, beforePluginsWithdraw, onPluginWithdrawAbandoned, usePlugins, recordOf, activeManifest, type PluginsCommit } from "../plugins/store";
import { notePasswordManagerChosen, notePasswordPanel, noteProfilesMovedBack } from "../telemetry/passwordManagerCounts";
import { isBundledRetiredRecord, RETIRED_OFFICIAL_PLUGINS, retiredRecordOf } from "../plugins/retiredOfficial";
import {
  choiceKind,
  fieldProviderSet,
  managerPluginOf,
  managerPlugins,
  neverChosenProfiles,
  passwordManagerProfileCounts,
  pluginChoice,
  profilePasswordManager,
  profilesSharingData,
  regularProfileId,
  storedPasswordManager,
  type ManagerPlugin,
  type PasswordManagerChoice,
} from "./passwordManagerChoice";
import { closeVerificationCodePrompts, offerVerificationCode } from "./verificationCodes";
import { followMode, forgetHeldOffOutside, forgetPendingOfferToSave, offerToSaveHeldOffSomewhere, passwordAutofill, pendingOfferToSave, startOfferToSave, watchPendingOfferToSave, writeOfferToSave } from "./offerToSave";

export { forgetPendingOfferToSave, passwordAutofill };
export { type FieldProviderHint, type FieldProviderOpened, type VerificationCodeFound };


const browser = () => useBrowser.getState();
const pluginsView = () => usePlugins.getState();

const currentManagerPlugins = () => managerPlugins(pluginsView());

export const currentPasswordManager = (profileId: string): PasswordManagerChoice => profilePasswordManager(browser(), currentManagerPlugins(), profileId);

export function currentManagerPlugin(profileId: string): ManagerPlugin | null {
  const plugins = currentManagerPlugins();
  return managerPluginOf(plugins, profilePasswordManager(browser(), plugins, profileId));
}

const pluginsKey = (plugins: readonly ManagerPlugin[]) => JSON.stringify(plugins);

export function useManagerPlugins(): ManagerPlugin[] {
  const key = usePlugins((p) => pluginsKey(managerPlugins(p)));
  return JSON.parse(key) as ManagerPlugin[];
}

export function useProfilePasswordManager(profileId: string): PasswordManagerChoice {
  const plugins = useManagerPlugins();
  return useBrowser((s) => profilePasswordManager(s, plugins, profileId));
}

export const useStoredPasswordManager = (profileId: string) => useBrowser((s) => storedPasswordManager(s, profileId));

export function useProfilesSharingChoice(profileId: string): string[] {
  return useBrowser(
    useShallow((s) =>
      profilesSharingData(s, profileId)
        .filter((id) => id !== profileId)
        .map((id) => s.profiles[id]!.name),
    ),
  );
}

export function useProfilesUsing(name: string): string[] {
  const plugins = useManagerPlugins();
  return useBrowser(
    useShallow((s) => s.profileOrder.filter((id) => s.profiles[id] && profilePasswordManager(s, plugins, id) === pluginChoice(name)).map((id) => s.profiles[id]!.name)),
  );
}

export function useNeverChosenCount(): number {
  return useBrowser((s) => neverChosenProfiles(s).length);
}

export const neverChosenCount = () => neverChosenProfiles(browser()).length;

let engage = () => {};

export function choosePasswordManager(profileId: string, manager: PasswordManagerChoice) {
  const s = browser();
  notePasswordManagerChosen(choiceKind(manager));
  engage();
  for (const id of profilesSharingData(s, profileId)) s.updateProfile(id, { passwordManager: manager });
}

const choseAwayFromArdia = (s: BrowserState) => Object.values(s.profiles).some((p) => !!p && p.passwordManager !== undefined && p.passwordManager !== "ardia");

let heldOffAtStart: boolean | null = null;

function passwordManagerInUse(): boolean {
  if (currentManagerPlugins().length > 0 || choseAwayFromArdia(browser())) return true;
  heldOffAtStart ??= offerToSaveHeldOffSomewhere();
  return heldOffAtStart;
}

function adoptNeverChosen(name: string) {
  const s = browser();
  for (const id of neverChosenProfiles(s)) if (s.profiles[id] && !s.profiles[id]!.passwordManager) s.updateProfile(id, { passwordManager: pluginChoice(name) });
}

function keepArdiaForRetired(consent: ConsentToken | null, stamped: Set<string>): boolean {
  const s = browser();
  const plugins = pluginsView();
  const moved = new Map<string, string>();
  let settled = true;
  for (const name of Object.keys(RETIRED_OFFICIAL_PLUGINS)) {
    if (stamped.has(name)) continue;
    const retired = retiredRecordOf(name);
    if (!retired) {
      if (isBundledRetiredRecord(name, plugins.records[name])) settled = false;
      continue;
    }
    stamped.add(name);
    const rollbackPicksIt = retired.enabled;
    const unset = rollbackPicksIt ? new Set(neverChosenProfiles(s)) : new Set<string>();
    for (const [id, profile] of Object.entries(s.profiles)) if (profile && (profile.passwordManager === pluginChoice(name) || unset.has(id))) moved.set(id, engineProfile(s, id));
  }
  if (!moved.size) return settled;
  for (const id of moved.keys()) s.updateProfile(id, { passwordManager: "ardia" });
  noteProfilesMovedBack(new Set(moved.values()).size, consent);
  return settled;
}

const liveEngineProfiles = (s: BrowserState) => new Set(Object.keys(s.profiles).filter((id) => s.profiles[id]).map((id) => engineProfile(s, id)));

function engineModes(s: BrowserState, plugins: readonly ManagerPlugin[]): Map<string, PasswordManagerChoice> {
  const modes = new Map<string, PasswordManagerChoice>();
  for (const id of Object.keys(s.profiles).sort()) {
    const profile = engineProfile(s, id);
    if (!modes.has(profile)) modes.set(profile, profilePasswordManager(s, plugins, id));
  }
  return modes;
}

function shownEngineProfiles(s: BrowserState): Set<string> {
  const shown = new Set<string>();
  for (const w of Object.values(s.windows)) if (w) shown.add(engineProfile(s, regularProfileId(w.profileId)));
  return shown;
}

function unifySharedChoices() {
  const s = browser();
  const grouped = new Set<string>();
  for (const id of Object.keys(s.profiles)) {
    if (grouped.has(id)) continue;
    const sharing = profilesSharingData(s, id);
    for (const member of sharing) grouped.add(member);
    const choice = storedPasswordManager(s, id);
    if (!choice) continue;
    for (const member of sharing) if (s.profiles[member]?.passwordManager !== choice) s.updateProfile(member, { passwordManager: choice });
  }
}

let generation = 0;
let pushed: string | null = null;
let wanted: { key: string; confirmed: Promise<void>; confirm: () => void } | null = null;
let inFlight: string | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let bareNoted = false;
const ATTEMPT_MS = 1000;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;

const withdrawing = new Set<string>();
const commitPlugins = (commit: PluginsCommit) => managerPlugins({ ...commit, order: Object.keys(commit.listings).sort() });
const providerPlugins = (plugins: readonly ManagerPlugin[]) => (withdrawing.size ? plugins.filter((p) => !withdrawing.has(p.name)) : plugins);

function retryPush(consent: ConsentToken | null) {
  clearTimeout(retry);
  const delay = Math.min(RETRY_FIRST_MS * 2 ** attempts, RETRY_MAX_MS);
  attempts += 1;
  retry = setTimeout(() => void pushProviders(providerPlugins(currentManagerPlugins()), consent, true), delay);
}

function want(key: string) {
  if (wanted?.key === key) return wanted;
  let confirm = () => {};
  const confirmed = new Promise<void>((resolve) => (confirm = resolve));
  wanted = { key, confirmed, confirm };
  attempts = 0;
  clearTimeout(retry);
  return wanted;
}

function pushProviders(plugins: readonly ManagerPlugin[], consent: ConsentToken | null, again = false): Promise<void> {
  const { providers, key } = fieldProviderSet(browser(), plugins);
  if (!again && key === pushed && inFlight === null) return Promise.resolve();
  const target = want(key);
  if (!again && inFlight === key) return target.confirmed;
  pushed = null;
  inFlight = key;
  generation += 1;
  const sent = generation;
  closeVerificationCodePrompts();
  let answered = false;
  const watchdog = setTimeout(() => !answered && sent === generation && retryPush(consent), ATTEMPT_MS);
  const settle = (applied: boolean) => {
    answered = true;
    clearTimeout(watchdog);
    if (sent !== generation) return;
    inFlight = null;
    if (!applied) return retryPush(consent);
    pushed = key;
    attempts = 0;
    clearTimeout(retry);
    target.confirm();
  };
  void setFieldProviders(sent, providers).then(
    (reply) => {
      if (!reply.answered && !bareNoted) {
        bareNoted = true;
        warnFor(consent, "[passwords] native answered setFieldProviders without applied; retrying");
      }
      settle(reply.applied);
    },
    () => settle(false),
  );
  return target.confirmed;
}

export const providerGeneration = () => generation;

function newlyTurnedOn(next: PluginsCommit, before: PluginsCommit): string[] {
  return Object.keys(next.records).filter((name) => {
    const was = recordOf(before, name);
    const now = recordOf(next, name);
    if (!now.enabled || (was.enabled && was.approved === now.approved)) return false;
    const m = activeManifest(next, name);
    return !!m?.passwordManager && !!next.listings[name]?.official;
  });
}

let started = false;

export function startPasswordManager() {
  if (started || !PLATFORM_FEATURES.systemPasswordManagers || !PLATFORM_FEATURES.plugins) return;
  started = true;
  startOfferToSave();
  const startConsent = consentToken();
  let modes = new Map<string, PasswordManagerChoice>();
  let seen = new Set<string>();
  let unifying = false;
  let ready = false;
  let retiredKept = false;
  const retiredStamped = new Set<string>();
  const keepRetired = (committing = false) => {
    if (!retiredKept && (committing || pluginsView().scanned)) retiredKept = keepArdiaForRetired(startConsent, retiredStamped);
  };

  const plugins = () => managerPlugins(pluginsView());

  const syncModes = () => {
    if (!ready) return;
    const current = plugins();
    const next = engineModes(browser(), current);
    for (const [profile, mode] of next) if (modes.get(profile) !== mode) followMode(profile, mode);
    modes = next;
    void pushProviders(providerPlugins(current), consentToken());
  };

  const syncWindows = () => {
    const shown = shownEngineProfiles(browser());
    for (const profile of shown) if (!seen.has(profile)) writeOfferToSave(profile);
    seen = shown;
  };

  const syncReady = () => {
    if (!pendingOfferToSave()) return;
    const s = browser();
    for (const tabId of Object.keys(usePages.getState().ready)) {
      const tab = s.tabs[tabId];
      if (tab) writeOfferToSave(engineProfile(s, regularProfileId(tab.profileId)));
    }
  };

  const syncProfiles = () => {
    if (unifying) return;
    unifying = true;
    try {
      unifySharedChoices();
    } finally {
      unifying = false;
    }
    syncModes();
  };

  beforePluginsCommit((next, before) => {
    keepRetired(true);
    if (!ready && commitPlugins(next).length) begin(true);
    if (!ready) return;
    const active = new Set(commitPlugins(next).map((p) => p.name));
    for (const name of [...withdrawing]) if (!active.has(name) || recordOf(next, name) !== recordOf(before, name)) withdrawing.delete(name);
    for (const name of newlyTurnedOn(next, before)) adoptNeverChosen(name);
    void pushProviders(providerPlugins(commitPlugins(next)), consentToken());
  });

  beforePluginsWithdraw((next) => {
    if (!ready) return undefined;
    const staying = new Set(commitPlugins(next).map((p) => p.name));
    for (const p of currentManagerPlugins()) if (!staying.has(p.name)) withdrawing.add(p.name);
    return pushProviders(providerPlugins(commitPlugins(next)), consentToken());
  });

  onPluginWithdrawAbandoned((name, consent) => {
    if (!withdrawing.delete(name) || !ready) return;
    void pushProviders(providerPlugins(currentManagerPlugins()), consent);
  });

  let stopWatchingReady: (() => void) | null = null;
  const watchReady = (pending: boolean) => {
    if (pending && !stopWatchingReady) stopWatchingReady = usePages.subscribe((s, prev) => s.ready !== prev.ready && syncReady());
    else if (!pending && stopWatchingReady) {
      stopWatchingReady();
      stopWatchingReady = null;
    }
  };
  const begin = (inUse = false) => {
    if (ready || !pluginsView().scanned) return;
    keepRetired();
    if (!(inUse || passwordManagerInUse())) return;
    ready = true;
    void forgetHeldOffOutside(liveEngineProfiles(browser()));
    syncProfiles();
    syncWindows();
    syncReady();
    watchPendingOfferToSave(watchReady);
    watchReady(pendingOfferToSave() > 0);
    useBrowser.subscribeTo(["profiles", "windows"], (s, prev) => {
      if (s.profiles !== prev.profiles) syncProfiles();
      if (s.windows !== prev.windows) syncWindows();
    });
  };
  engage = () => begin(true);

  usePlugins.subscribe((s, prev) => {
    const changed = s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order;
    if (changed) keepRetired();
    if (!ready) return void ((changed || s.scanned !== prev.scanned) && begin());
    if (changed) syncModes();
  });
  begin();
}

function codeSetupOn(tabId: string): boolean {
  const tab = browser().tabs[tabId];
  return !!tab && currentManagerPlugin(tab.profileId)?.spec.verificationCodeSetup === "system";
}

export const verificationCodeFound = (tabId: string, found: VerificationCodeFound) => offerVerificationCode(tabId, found, codeSetupOn, generation);

export function fieldProviderOpened(tabId: string, event: FieldProviderOpened) {
  if (event?.via === "badge" || event?.via === "menu") notePasswordPanel(event.via, event.shown === true, event.reason);
  void offerPanelHint(tabId, event);
}

export const fieldProviderHint = (tabId: string, hint: FieldProviderHint) => panelHintReported(tabId, hint);

const PANEL_MAY_BE_UP = new Set(["noPanel", "tabGone"]);

export async function openSystemPanel(tabId: string): Promise<boolean> {
  const result = await showSystemPanel(tabId, generation).catch(() => null);
  return !!result && (result.shown || PANEL_MAY_BE_UP.has(result.reason ?? ""));
}

export function passwordManagerSnapshot(): Record<string, string> | null {
  if (!PLATFORM_FEATURES.systemPasswordManagers || !PLATFORM_FEATURES.plugins) return {};
  return pluginsView().scanned ? passwordManagerProfileCounts(browser(), currentManagerPlugins()) : null;
}
