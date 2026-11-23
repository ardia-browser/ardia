import { compareVersions, readManifest, type PluginManifest } from "../../lib/pluginManifest";
import { hexOf, sha256 } from "../../lib/sha256";
import { DECIDE_EVENTS, PLUGIN_EVENTS } from "../automation/eventNames";
import { checkedSettings } from "../config/configSettings";
import type { Settings } from "../settings/settings";
import type { PluginListing } from "./store";

const APPROVED_SETTINGS: readonly string[] = ["omniboxProviders", "launchActions"];

const UNTABBED_EVENTS: ReadonlySet<string> = new Set([
  "settings.changed",
  "app.launched",
  "app.quitting",
  "app.activated",
  "app.deactivated",
  "system.sleep",
  "system.wake",
  "user.idle",
  "user.active",
]);

export type ProgramClaims = { claims: Readonly<Record<string, string>>; failClosed: boolean };
export const NO_CLAIMS: ProgramClaims = { claims: {}, failClosed: false };

export const PLUGIN_RULES = { untabbedEvents: [...UNTABBED_EVENTS], approvedSettings: APPROVED_SETTINGS, decideEvents: [...DECIDE_EVENTS] };

export const manifestHash = (text: string, folderId = "") => hexOf(sha256(`${text}\u0000${folderId}`));

const LEGACY_OFFICIAL = "bundled";
const OFFICIAL_FOLDER = /^official-[0-9a-f]{64}$/;

const isOfficialFolder = (folderId: string) => folderId === LEGACY_OFFICIAL || OFFICIAL_FOLDER.test(folderId);

export function appProblems(m: PluginManifest, settings: Settings, appVersion: string, folderId = "", registry: ProgramClaims = NO_CLAIMS): string[] {
  const problems: string[] = [];
  const label = `plugin.json: ${m.declaredManifest < 2 ? "" : "contributes."}settings.defaults`;
  problems.push(...checkedSettings(label, m.settings.defaults, settings).problems);
  for (const key of APPROVED_SETTINGS) if (Object.hasOwn(m.settings.defaults, key)) problems.push(`${label}: ${key} needs its own approval in Settings, so a plugin can't set it`);
  const within = m.declaredManifest < 2 ? "" : "contributes.";
  const hookPath = `${within}hooks`;
  m.hooks.forEach((name, i) => {
    const decides = (DECIDE_EVENTS as readonly string[]).includes(name);
    if (!decides && !(PLUGIN_EVENTS as readonly string[]).includes(name)) problems.push(`plugin.json: ${hookPath}[${i}]: ${name} isn't an event plugins can receive`);
    else if ((decides || !UNTABBED_EVENTS.has(name)) && !m.permissions.tabs) problems.push(`plugin.json: ${hookPath}[${i}]: ${name} needs the tabs permission`);
  });
  const builtIn = isOfficialFolder(folderId);
  m.programs.forEach((p, i) => {
    const at = `plugin.json: ${within}programs[${i}]`;
    const owner = registry.claims[p.name];
    if (p.claim && !builtIn) problems.push(`${at}.claim is only for Ardia's official plugins`);
    else if (owner && registry.failClosed) problems.push(`${at}.name: ${p.name} is kept for Ardia's official plugins, and the list of which one owns it couldn't be read`);
    else if (owner && (owner !== m.name || !builtIn)) problems.push(`${at}.name: ${p.name} belongs to Ardia's official ${owner} plugin`);
    else if (p.claim && owner !== m.name) problems.push(`${at}.claim: ${p.name} isn't in the list of programs this Ardia reserves for its official plugins`);
  });
  for (const key of ["alwaysOn", "official", "autoInstall"] as const) if (m[key] && !builtIn) problems.push(`plugin.json: ${key} is only for Ardia's official plugins`);
  if (m.autoInstall && !m.alwaysOn) problems.push("plugin.json: autoInstall needs alwaysOn");
  m.programs.forEach((p, i) => {
    if (p.afterUpdate.length && !builtIn) problems.push(`plugin.json: ${within}programs[${i}].afterUpdate is only for Ardia's official plugins`);
  });
  if (m.requires && appVersion && compareVersions(appVersion, m.requires) < 0) problems.push(`plugin.json: needs Ardia ${m.requires} or later (this is ${appVersion})`);
  return problems;
}

export function listingOf(name: string, text: string | null, readProblem: string | null, settings: Settings, appVersion: string, folderId = "", registry: ProgramClaims = NO_CLAIMS): PluginListing {
  if (text === null) return { name, manifest: null, problems: [readProblem ?? "plugin.json couldn't be read"], hash: null, folderId };
  const hash = manifestHash(text, folderId);
  const read = readManifest(text);
  if (!read.manifest) return { name, manifest: null, problems: read.problems, hash, folderId };
  const problems = appProblems(read.manifest, settings, appVersion, folderId, registry);
  if (read.manifest.name !== name) problems.push(`plugin.json: name is ${read.manifest.name}, but its folder is ${name}`);
  return problems.length ? { name, manifest: null, problems, hash, folderId } : { name, manifest: read.manifest, problems: [], hash, folderId };
}
