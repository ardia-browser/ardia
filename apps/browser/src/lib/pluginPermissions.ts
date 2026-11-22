import { isFields } from "./decode";
import { LIMITS, only, type Check } from "./pluginChecks";
import { ANY_HOST, hostPatternCovers, hostPatternProblem } from "./pluginNetwork";
import { t } from "./uiLanguage";


export const PLUGIN_PERMISSIONS = ["tabs", "fullUrls", "commands", "network", "control"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PERMISSION_KEYS = ["tabs", "fullUrls", "activePage", "workspace", "commands", "storage", "secrets", "network", "control"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const TAB_ACCESS = ["read", "write"] as const;
export type TabAccess = (typeof TAB_ACCESS)[number];
export type NetworkAccess = false | typeof ANY_HOST | string[];

export type PluginPermissions = {
  tabs: TabAccess | false;
  fullUrls: boolean;
  activePage: boolean;
  workspace: boolean;
  commands: boolean;
  storage: boolean;
  secrets: boolean;
  network: NetworkAccess;
  control: boolean;
};

export const NO_PERMISSIONS: PluginPermissions = { tabs: false, fullUrls: false, activePage: false, workspace: false, commands: false, storage: false, secrets: false, network: false, control: false };

const BOOLEAN_KEYS = ["fullUrls", "activePage", "workspace", "commands", "storage", "secrets", "control"] as const;

export function legacyPermissions(given: unknown): unknown {
  if (!Array.isArray(given)) return given;
  const out: Record<string, unknown> = {};
  for (const p of given) {
    const name = typeof p === "string" ? p : JSON.stringify(p);
    if (name === "tabs") out.tabs = "read";
    else if (name === "network") out.network = ANY_HOST;
    else out[name] = true;
  }
  return out;
}

function networkOf(c: Check, value: unknown): NetworkAccess {
  if (value === undefined || value === false) return false;
  if (value === ANY_HOST || value === true) return ANY_HOST;
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.allowedHosts) {
    c.problems.push(`permissions.network must be false, "*" or a list of 1 to ${LIMITS.allowedHosts} hosts`);
    return false;
  }
  const hosts: string[] = [];
  value.forEach((host, i) => {
    const problem = hostPatternProblem(host);
    if (problem) c.problems.push(`permissions.network[${i}] ${problem}`);
    else if (host === ANY_HOST) c.problems.push(`permissions.network[${i}]: use "*" on its own instead of in a list`);
    else if (!hosts.includes(host as string)) hosts.push(host as string);
  });
  return hosts.length ? hosts : false;
}

export function permissionsOf(c: Check, value: unknown): PluginPermissions {
  if (value === undefined) return { ...NO_PERMISSIONS };
  if (!isFields(value)) {
    c.problems.push(`permissions must be an object of ${PERMISSION_KEYS.join(", ")}`);
    return { ...NO_PERMISSIONS };
  }
  only(c, "permissions", value, PERMISSION_KEYS);
  const out: PluginPermissions = { ...NO_PERMISSIONS };
  if (value.tabs !== undefined && value.tabs !== false) {
    if ((TAB_ACCESS as readonly unknown[]).includes(value.tabs)) out.tabs = value.tabs as TabAccess;
    else c.problems.push(t(`permissions.tabs must be read, write or false`));
  }
  for (const key of BOOLEAN_KEYS) {
    const given = value[key];
    if (given === undefined) continue;
    if (typeof given === "boolean") out[key] = given;
    else c.problems.push(`permissions.${key} must be true or false`);
  }
  out.network = networkOf(c, value.network);
  if (out.fullUrls && !out.tabs) c.problems.push(t(`permissions: fullUrls needs tabs`));
  if (out.workspace && (out.tabs !== "write" || !out.fullUrls)) c.problems.push(t(`permissions: workspace needs tabs: write and fullUrls, since it sees and moves every tab`));
  return out;
}

export function grantedPermissions(p: PluginPermissions): string[] {
  const out: string[] = [];
  if (p.tabs) out.push(p.tabs === "write" ? "tabs:write" : "tabs");
  for (const key of BOOLEAN_KEYS) if (p[key]) out.push(key);
  if (p.network === ANY_HOST) out.push("network");
  else if (p.network) out.push(...p.network.map((host) => `network:${host}`));
  return out;
}

function networkCovers(caller: NetworkAccess, callee: NetworkAccess): boolean {
  if (callee === false || caller === ANY_HOST) return true;
  if (caller === false || callee === ANY_HOST) return false;
  return callee.every((host) => caller.some((pattern) => hostPatternCovers(pattern, host)));
}

export function missingPermissions(caller: PluginPermissions, callee: PluginPermissions): string[] {
  const missing: string[] = [];
  if (callee.tabs && (!caller.tabs || (callee.tabs === "write" && caller.tabs !== "write"))) missing.push(callee.tabs === "write" ? "tabs:write" : "tabs");
  for (const key of BOOLEAN_KEYS) if (callee[key] && !caller[key]) missing.push(key);
  if (!networkCovers(caller.network, callee.network)) missing.push("network");
  return missing;
}

export const canReadTabs = (p: PluginPermissions) => p.tabs !== false;
export const canOpenTabs = (p: PluginPermissions) => p.commands || p.tabs === "write";
export const hasNetwork = (p: PluginPermissions) => p.network !== false;
export const allowedHostsOf = (p: PluginPermissions): string[] => (p.network === false ? [] : p.network === ANY_HOST ? [ANY_HOST] : [...p.network]);
