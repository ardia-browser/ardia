import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import type { PasswordManagerSpec } from "../../lib/pluginPasswordManager";
import type { Profile } from "../browser/types";
import { engineProfile, incognitoOriginal, isIncognitoProfile } from "../browser/model";
import { activeManifest, type PluginsStore } from "../plugins/store";

export type PasswordManagerChoice = "ardia" | "none" | `plugin:${string}`;
export type PasswordManagerKind = "ardia" | "none" | "plugin";
export type ManagerPlugin = { name: string; title: string; spec: PasswordManagerSpec; builtIn: boolean; approval: string };

const PLUGIN_PREFIX = "plugin:";
const PLUGIN_CHOICE = /^plugin:[a-z0-9][a-z0-9-]{0,39}$/;

export const pluginChoice = (name: string): PasswordManagerChoice => `${PLUGIN_PREFIX}${name}` as PasswordManagerChoice;
export const choicePlugin = (choice: string): string | null => (choice.startsWith(PLUGIN_PREFIX) ? choice.slice(PLUGIN_PREFIX.length) : null);
export const isPasswordManagerChoice = (value: unknown): value is PasswordManagerChoice =>
  value === "ardia" || value === "none" || (typeof value === "string" && PLUGIN_CHOICE.test(value));
export const choiceKind = (choice: PasswordManagerChoice): PasswordManagerKind => (choice === "ardia" || choice === "none" ? choice : "plugin");

type PluginsView = Pick<PluginsStore, "listings" | "records" | "order">;

export function managerPlugins(p: PluginsView): ManagerPlugin[] {
  if (!PLATFORM_FEATURES.systemPasswordManagers || !PLATFORM_FEATURES.plugins) return [];
  return p.order.flatMap((name) => {
    const m = activeManifest(p, name);
    return m?.passwordManager ? [{ name, title: m.title, spec: m.passwordManager, builtIn: !!p.listings[name]?.official, approval: p.listings[name]?.hash ?? "" }] : [];
  });
}

export const regularProfileId = (profileId: string) => (isIncognitoProfile(profileId) ? incognitoOriginal(profileId) : profileId);

type ChoiceState = { profiles: Record<string, Profile | undefined> };

const dataOf = (profile: Pick<Profile, "id" | "dataId">) => profile.dataId ?? profile.id;

export function profilesSharingData(s: ChoiceState, profileId: string): string[] {
  const own = s.profiles[regularProfileId(profileId)];
  if (!own) return [];
  const data = dataOf(own);
  const order = [data, ...Object.keys(s.profiles).sort()];
  return [...new Set(order)].filter((id) => s.profiles[id] && dataOf(s.profiles[id]!) === data);
}

export function storedPasswordManager(s: ChoiceState, profileId: string): PasswordManagerChoice | undefined {
  return profilesSharingData(s, profileId)
    .map((id) => s.profiles[id]!.passwordManager)
    .find(isPasswordManagerChoice);
}

export function defaultPasswordManager(plugins: readonly ManagerPlugin[]): PasswordManagerChoice {
  const builtIn = plugins.find((p) => p.builtIn);
  return builtIn ? pluginChoice(builtIn.name) : "ardia";
}

export function effectivePasswordManager(stored: PasswordManagerChoice | undefined, plugins: readonly ManagerPlugin[]): PasswordManagerChoice {
  if (!PLATFORM_FEATURES.systemPasswordManagers) return "ardia";
  if (stored === undefined) return defaultPasswordManager(plugins);
  const name = choicePlugin(stored);
  return name === null || plugins.some((p) => p.name === name) ? stored : "ardia";
}

export const profilePasswordManager = (s: ChoiceState, plugins: readonly ManagerPlugin[], profileId: string): PasswordManagerChoice =>
  effectivePasswordManager(storedPasswordManager(s, profileId), plugins);

export function managerPluginOf(plugins: readonly ManagerPlugin[], choice: PasswordManagerChoice): ManagerPlugin | null {
  const name = choicePlugin(choice);
  return name === null ? null : (plugins.find((p) => p.name === name) ?? null);
}

export function neverChosenProfiles(s: ChoiceState): string[] {
  return Object.keys(s.profiles)
    .sort()
    .filter((id) => storedPasswordManager(s, id) === undefined);
}

export type ProviderState = ChoiceState & Pick<Parameters<typeof engineProfile>[0], "profiles">;

export type FieldProviderEntry = { profile: string; fields: ManagerPlugin["spec"]["fields"]; codeSetup: boolean };

export function fieldProviderSet(s: ProviderState, plugins: readonly ManagerPlugin[]): { providers: FieldProviderEntry[]; key: string } {
  const byEngine = new Map<string, { entry: FieldProviderEntry; by: string }>();
  for (const id of Object.keys(s.profiles).sort()) {
    const plugin = managerPluginOf(plugins, profilePasswordManager(s, plugins, id));
    if (!plugin || plugin.spec.fill !== "system") continue;
    const profile = engineProfile(s, id);
    if (!byEngine.has(profile)) byEngine.set(profile, { entry: { profile, fields: [...plugin.spec.fields], codeSetup: plugin.spec.verificationCodeSetup === "system" }, by: `${plugin.name}:${plugin.approval}` });
  }
  const sorted = [...byEngine.values()].sort((a, b) => (a.entry.profile < b.entry.profile ? -1 : a.entry.profile > b.entry.profile ? 1 : 0));
  return { providers: sorted.map((x) => x.entry), key: JSON.stringify(sorted) };
}

export const fieldProviders = (s: ProviderState, plugins: readonly ManagerPlugin[]) => fieldProviderSet(s, plugins).providers;

export function passwordManagerProfileCounts(s: ChoiceState, plugins: readonly ManagerPlugin[]): Record<string, string> {
  const counts: Record<PasswordManagerKind, number> = { ardia: 0, none: 0, plugin: 0 };
  for (const id of Object.keys(s.profiles)) counts[choiceKind(profilePasswordManager(s, plugins, id))]++;
  return {
    password_manager_profiles_ardia: String(counts.ardia),
    password_manager_profiles_none: String(counts.none),
    password_manager_profiles_plugin: String(counts.plugin),
  };
}
