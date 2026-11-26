import { readManifest, type PluginManifest } from "../../lib/pluginManifest";
import { isSemver, parseRange, parseSemver, compareSemver, satisfies } from "@ardia/plugin-sdk/semver";
import { folderMatchesId, idOfKey, isOfficialId, keyOfId } from "../../lib/pluginIds";
import type { PluginSource } from "../../platform/plugins";
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

export const RESERVED_PROGRAMS: Readonly<Record<string, string>> = { ardia: "ardia__cli" };

export const PLUGIN_RULES = { untabbedEvents: [...UNTABBED_EVENTS], approvedSettings: APPROVED_SETTINGS, decideEvents: [...DECIDE_EVENTS] };

export const manifestHash = (text: string, folderId = "") => hexOf(sha256(`${text}\u0000${folderId}`));

export function aboveRange(version: string, range: string): boolean {
  const parsed = parseRange(range);
  const at = parseSemver(version);
  if (!parsed || !at) return false;
  return parsed.sets.every((set) => set.some((c) => (c.op === "<" && compareSemver(at, c.version) >= 0) || (c.op === "<=" && compareSemver(at, c.version) > 0)));
}

export function pluginsArdiaVersion(appVersion: string): string | null {
  if (isSemver(appVersion)) return appVersion;
  const short = /^(\d+)\.(\d+)$/.exec(appVersion);
  return short ? `${short[1]}.${short[2]}.0` : null;
}

export function engineProblem(m: Pick<PluginManifest, "engines">, given: string): string | null {
  const appVersion = pluginsArdiaVersion(given);
  if (!appVersion || satisfies(appVersion, m.engines.ardia, { includePrerelease: true })) return null;
  return aboveRange(appVersion, m.engines.ardia) ? `Incompatible with Ardia ${appVersion} — waiting for plugin update` : `Needs Ardia ${m.engines.ardia} (this is ${appVersion})`;
}

export function appProblems(m: PluginManifest, settings: Settings, appVersion: string, source: PluginSource = "local"): string[] {
  const problems: string[] = [];
  const label = "plugin.json: contributes.settings.defaults";
  problems.push(...checkedSettings(label, m.settings.defaults, settings).problems);
  for (const key of APPROVED_SETTINGS) if (Object.hasOwn(m.settings.defaults, key)) problems.push(`${label}: ${key} needs its own approval in Settings, so a plugin can't set it`);
  m.hooks.forEach((name, i) => {
    const decides = (DECIDE_EVENTS as readonly string[]).includes(name);
    if (!decides && !(PLUGIN_EVENTS as readonly string[]).includes(name)) problems.push(`plugin.json: contributes.hooks[${i}]: ${name} isn't an event plugins can receive`);
    else if ((decides || !UNTABBED_EVENTS.has(name)) && !m.permissions.tabs) problems.push(`plugin.json: contributes.hooks[${i}]: ${name} needs the tabs permission`);
  });
  const official = source === "store" && isOfficialId(m.id);
  m.programs.forEach((p, i) => {
    const at = `plugin.json: contributes.programs[${i}]`;
    const owner = RESERVED_PROGRAMS[p.name.toLowerCase()];
    if (owner && (owner !== m.name || !official)) problems.push(`${at}.name: ${p.name} belongs to Ardia's official ${idOfKey(owner) ?? owner} plugin`);
    if (p.claim && !official) problems.push(`${at}.claim is only for Ardia's official plugins`);
    if (p.afterUpdate.length && !official) problems.push(`${at}.afterUpdate is only for Ardia's official plugins`);
  });
  if (isOfficialId(m.id) && source === "local") problems.push(`plugin.json: ${m.id} is an official plugin, so it comes only from Ardia's registry or a dev link`);
  const engines = engineProblem(m, appVersion);
  if (engines) problems.push(engines);
  return problems;
}

export function listingOf(name: string, text: string | null, readProblem: string | null, settings: Settings, appVersion: string, folderId = "", source: PluginSource = "local"): PluginListing {
  if (text === null) return { name, manifest: null, problems: [readProblem ?? "plugin.json couldn't be read"], hash: null, folderId };
  const hash = manifestHash(text, folderId);
  const read = readManifest(text, name);
  if (!read.manifest) return { name, manifest: null, problems: read.problems, hash, folderId };
  const problems = appProblems(read.manifest, settings, appVersion, source);
  const id = read.manifest.id;
  if (source === "local" ? !folderMatchesId(name, id) : keyOfId(id) !== name) problems.push(`plugin.json: id is ${id}, but its folder is ${name}`);
  return problems.length ? { name, manifest: null, problems, hash, folderId } : { name, manifest: read.manifest, problems: [], hash, folderId };
}
