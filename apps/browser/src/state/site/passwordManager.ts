import { setFieldProviders, showSystemPanel, type FieldProviderOpened, type VerificationCodeFound } from "../../platform/passwordProviders";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { warnFor } from "../telemetry/consoleConsent";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, privateSession } from "../browser/model";
import { sortedProfiles } from "../profiles/profiles";
import { usePages } from "../tabs/pageState";
import { useShallow } from "zustand/react/shallow";
import { beforePluginsCommit, beforePluginsWithdraw, onPluginWithdrawAbandoned, usePlugins, recordOf, activeManifest, type PluginsCommit } from "../plugins/store";
import { notePasswordManagerChosen, notePasswordPanel } from "../telemetry/passwordManagerCounts";
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
  storedPasswordManager,
  type ManagerPlugin,
  type PasswordManagerChoice,
} from "./passwordManagerChoice";
import { closeVerificationCodePrompts, offerVerificationCode } from "./verificationCodes";
import { followMode, forgetPendingOfferToSave, passwordAutofill, pendingOfferToSave, writeOfferToSave } from "./offerToSave";

export { forgetPendingOfferToSave, passwordAutofill };
export { profilesSharingData, type ManagerPlugin, type PasswordManagerChoice, type VerificationCodeFound };


const browser = () => useBrowser.getState();
const pluginsView = () => usePlugins.getState();

export const currentManagerPlugins = () => managerPlugins(pluginsView());

export const currentPasswordManager = (profileId: string): PasswordManagerChoice => profilePasswordManager(browser(), currentManagerPlugins(), profileId);

export function currentManagerPlugin(profileId: string): ManagerPlugin | null {
  const plugins = currentManagerPlugins();
  return managerPluginOf(plugins, profilePasswordManager(browser(), plugins, profileId));
}

const browsingEngine = (s: BrowserState, spaceId: string) => privateSession(s, spaceId) ?? engineProfile(s, spaceId);

export function currentManagerPluginForSpace(spaceId: string): ManagerPlugin | null {
  const s = browser();
  const engineId = browsingEngine(s, spaceId);
  const profile = Object.values(s.profiles).find((entry) => entry.engineId === engineId);
  return profile ? currentManagerPlugin(profile.id) : null;
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
    useShallow((s) => sortedProfiles(s.profiles).filter(({ id }) => profilePasswordManager(s, plugins, id) === pluginChoice(name)).map(({ name: label }) => label)),
  );
}

export function useNeverChosenCount(): number {
  return useBrowser((s) => neverChosenProfiles(s).length);
}

export const neverChosenCount = () => neverChosenProfiles(browser()).length;

export function choosePasswordManager(profileId: string, manager: PasswordManagerChoice) {
  const s = browser();
  notePasswordManagerChosen(choiceKind(manager));
  for (const id of profilesSharingData(s, profileId)) s.updateProfile(id, { passwordManager: manager });
}

function adoptNeverChosen(name: string) {
  const s = browser();
  for (const id of neverChosenProfiles(s)) if (s.profiles[id] && !s.profiles[id]!.passwordManager) s.updateProfile(id, { passwordManager: pluginChoice(name) });
}

function engineModes(s: BrowserState, plugins: readonly ManagerPlugin[]): Map<string, PasswordManagerChoice> {
  const modes = new Map<string, PasswordManagerChoice>();
  for (const id of Object.keys(s.profiles).sort()) {
    const profile = s.profiles[id]!.engineId;
    if (!modes.has(profile)) modes.set(profile, profilePasswordManager(s, plugins, id));
  }
  return modes;
}

function shownEngineProfiles(s: BrowserState): Set<string> {
  const shown = new Set<string>();
  for (const w of Object.values(s.windows)) if (w) shown.add(browsingEngine(s, w.spaceId));
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
    return !!m?.passwordManager && !!next.listings[name]?.bundled;
  });
}

let started = false;

export function startPasswordManager() {
  if (started || !PLATFORM_FEATURES.systemPasswordManagers || !PLATFORM_FEATURES.plugins) return;
  started = true;
  let modes = new Map<string, PasswordManagerChoice>();
  let seen = new Set<string>();
  let unifying = false;
  let ready = false;

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
      if (tab) writeOfferToSave(browsingEngine(s, tab.spaceId));
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

  const begin = () => {
    if (ready || !pluginsView().scanned) return;
    ready = true;
    syncProfiles();
    syncWindows();
    syncReady();
  };

  begin();
  usePlugins.subscribe((s, prev) => {
    if (!ready) return begin();
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) syncModes();
  });
  usePages.subscribe((s, prev) => s.ready !== prev.ready && syncReady());
  useBrowser.subscribe((s, prev) => {
    if (s.profiles !== prev.profiles) syncProfiles();
    if (s.windows !== prev.windows) syncWindows();
  });
}

function codeSetupOn(tabId: string): boolean {
  const tab = browser().tabs[tabId];
  return !!tab && currentManagerPluginForSpace(tab.spaceId)?.spec.verificationCodeSetup === "system";
}

export const verificationCodeFound = (tabId: string, found: VerificationCodeFound) => offerVerificationCode(tabId, found, codeSetupOn, generation);

export function fieldProviderOpened(event: FieldProviderOpened) {
  if (event?.via === "badge" || event?.via === "menu") notePasswordPanel(event.via, event.shown === true);
}

export async function openSystemPanel(tabId: string): Promise<boolean> {
  const result = await showSystemPanel(tabId, generation).catch(() => null);
  return !!result?.shown;
}

export function passwordManagerSnapshot(): Record<string, string> | null {
  if (!PLATFORM_FEATURES.systemPasswordManagers || !PLATFORM_FEATURES.plugins) return {};
  return pluginsView().scanned ? passwordManagerProfileCounts(browser(), currentManagerPlugins()) : null;
}
