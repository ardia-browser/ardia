import { compareVersions, readManifest, type PluginManifest } from "../../lib/pluginManifest";
import { sha256 } from "../../lib/sha256";
import { PLUGIN_EVENTS } from "../automation/eventNames";
import { checkedSettings } from "../config/configSettings";
import type { Settings } from "../settings/settings";
import type { PluginListing } from "./store";

export const APPROVED_SETTINGS: readonly string[] = ["omniboxProviders", "launchActions"];

export const UNTABBED_EVENTS: ReadonlySet<string> = new Set([
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

export const RESERVED_PROGRAMS: Readonly<Record<string, string>> = { ardia: "cli" };

export const PLUGIN_RULES = { untabbedEvents: [...UNTABBED_EVENTS], approvedSettings: APPROVED_SETTINGS };

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const manifestHash = (text: string, folderId = "") => hex(sha256(`${text}\u0000${folderId}`));

export const BUILT_IN = "bundled";

export function appProblems(m: PluginManifest, settings: Settings, appVersion: string, folderId = ""): string[] {
  const problems: string[] = [];
  const label = `plugin.json: settings.defaults`;
  problems.push(...checkedSettings(label, m.settings.defaults, settings).problems);
  for (const key of APPROVED_SETTINGS) if (Object.hasOwn(m.settings.defaults, key)) problems.push(`${label}: ${key} needs its own approval in Settings, so a plugin can't set it`);
  m.hooks.forEach((name, i) => {
    if (!(PLUGIN_EVENTS as readonly string[]).includes(name)) problems.push(`plugin.json: hooks[${i}]: ${name} isn't an event plugins can receive`);
    else if (!UNTABBED_EVENTS.has(name) && !m.permissions.includes("tabs")) problems.push(`plugin.json: hooks[${i}]: ${name} needs the tabs permission`);
  });
  m.programs.forEach((p, i) => {
    const owner = RESERVED_PROGRAMS[p.name];
    if (owner && (owner !== m.name || folderId !== BUILT_IN)) problems.push(`plugin.json: programs[${i}].name: ${p.name} belongs to Ardia's built-in ${owner} plugin`);
  });
  const builtIn = folderId === BUILT_IN;
  for (const key of ["alwaysOn", "official", "autoInstall"] as const) if (m[key] && !builtIn) problems.push(`plugin.json: ${key} is only for plugins built into Ardia`);
  if (m.icon && !builtIn) problems.push("plugin.json: icon is only for plugins built into Ardia");
  if (m.autoInstall && !m.alwaysOn) problems.push("plugin.json: autoInstall needs alwaysOn");
  m.programs.forEach((p, i) => {
    if (p.afterUpdate.length && !builtIn) problems.push(`plugin.json: programs[${i}].afterUpdate is only for plugins built into Ardia`);
  });
  if (m.requires && appVersion && compareVersions(appVersion, m.requires) < 0) problems.push(`plugin.json: needs Ardia ${m.requires} or later (this is ${appVersion})`);
  return problems;
}

export function listingOf(name: string, text: string | null, readProblem: string | null, settings: Settings, appVersion: string, folderId = ""): PluginListing {
  if (text === null) return { name, manifest: null, problems: [readProblem ?? "plugin.json couldn't be read"], hash: null, folderId };
  const hash = manifestHash(text, folderId);
  const read = readManifest(text);
  if (!read.manifest) return { name, manifest: null, problems: read.problems, hash, folderId };
  const problems = appProblems(read.manifest, settings, appVersion, folderId);
  if (read.manifest.name !== name) problems.push(`plugin.json: name is ${read.manifest.name}, but its folder is ${name}`);
  return problems.length ? { name, manifest: null, problems, hash, folderId } : { name, manifest: read.manifest, problems: [], hash, folderId };
}
