import { useMemo } from "react";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { choicePlugin, managerPlugins, profilePasswordManager, regularProfileId, storedPasswordManager, type ManagerPlugin, type PasswordManagerChoice } from "../site/passwordManagerChoice";
import { recordOf, usePlugins, type PluginsStore } from "../plugins/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";

export const vaultsSupported = PLATFORM_FEATURES.systemPasswordManagers;

type ChoiceView = Pick<BrowserState, "profiles">;
type PluginsView = Pick<PluginsStore, "scanned" | "listings" | "records" | "order">;

const lastPluginOf = new Map<string, string>();

function heldByPlugin(s: ChoiceView, p: PluginsView, id: string, effective: PasswordManagerChoice): boolean {
  const named = choicePlugin(effective);
  if (named !== null) {
    lastPluginOf.set(id, named);
    return true;
  }
  const stored = storedPasswordManager(s, id);
  const kept = stored === undefined ? lastPluginOf.get(id) : stored === "ardia" ? undefined : choicePlugin(stored);
  if (kept && recordOf(p, kept).enabled) return true;
  lastPluginOf.delete(id);
  return false;
}

function onArdiaWith(s: ChoiceView, p: PluginsView, plugins: readonly ManagerPlugin[], profileId: string): boolean {
  if (!vaultsSupported || !p.scanned) return false;
  const id = regularProfileId(profileId);
  if (!s.profiles[id]) return false;
  const effective = profilePasswordManager(s, plugins, id);
  return !heldByPlugin(s, p, id, effective) && effective === "ardia";
}

const onArdia = (s: ChoiceView, plugins: readonly ManagerPlugin[], profileId: string) => onArdiaWith(s, usePlugins.getState(), plugins, profileId);

const currentPlugins = () => managerPlugins(usePlugins.getState());

export const vaultsOnForProfile = (profileId: string): boolean => onArdia(useBrowser.getState(), currentPlugins(), profileId);

export function vaultsOnForTab(tabId: string): boolean {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  return !!tab && tabEngine(s, tabId) === "chromium" && vaultsOnForProfile(tab.profileId);
}

export function ardiaProfiles(): string[] {
  if (!vaultsSupported) return [];
  const s = useBrowser.getState();
  const plugins = currentPlugins();
  return Object.keys(s.profiles)
    .sort()
    .filter((id) => onArdia(s, plugins, id));
}

export const anyProfileOnArdia = () => ardiaProfiles().length > 0;

export function ardiaEngineProfiles(): string[] {
  const s = useBrowser.getState();
  return [...new Set(ardiaProfiles().map((id) => engineProfile(s, id)))].sort();
}

export function onArdiaProfilesChanged(listener: (consent: ConsentToken | null) => void): () => void {
  const keyNow = () => `${ardiaProfiles().join("\n")}|${ardiaEngineProfiles().join("\n")}`;
  let last = keyNow();
  const check = () => {
    const now = keyNow();
    if (now === last) return;
    last = now;
    listener(consentToken());
  };
  const stopBrowser = useBrowser.subscribe((s, prev) => s.profiles !== prev.profiles && check());
  const stopPlugins = usePlugins.subscribe((p, prev) => (p.scanned !== prev.scanned || p.listings !== prev.listings || p.records !== prev.records || p.order !== prev.order) && check());
  return () => {
    stopBrowser();
    stopPlugins();
  };
}

function useCurrentPlugins(): ManagerPlugin[] {
  const key = usePlugins((p) => JSON.stringify([p.scanned, p.records, managerPlugins(p)]));
  return useMemo(() => (JSON.parse(key) as [boolean, unknown, ManagerPlugin[]])[2], [key]);
}

export function useVaultsOnForProfile(profileId: string): boolean {
  const plugins = useCurrentPlugins();
  return useBrowser((s) => onArdia(s, plugins, profileId));
}

export function useAnyProfileOnArdia(): boolean {
  const plugins = useCurrentPlugins();
  return useBrowser((s) => Object.keys(s.profiles).some((id) => onArdia(s, plugins, id)));
}
