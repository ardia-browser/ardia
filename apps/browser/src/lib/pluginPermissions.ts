import { isFields } from "./decode";
import { LIMITS, only, type Check } from "./pluginChecks";
import { ANY_HOST, hostPatternCovers, hostPatternProblem } from "./pluginNetwork";
import { stateAccessOf, stateGranted, stateMissing, type StateAccess } from "./pluginState";

export const PLUGIN_PERMISSIONS = ["tabs", "fullUrls", "commands", "network", "control"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PERMISSION_KEYS = ["tabs", "fullUrls", "activePage", "workspace", "commands", "storage", "files", "folders", "secrets", "network", "sites", "siteHeaders", "control", "state"] as const;
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
  files: boolean;
  folders: boolean;
  secrets: boolean;
  network: NetworkAccess;
  sites: string[];
  siteHeaders: string[];
  control: boolean;
  state: StateAccess | false;
};

export const NO_PERMISSIONS: PluginPermissions = { tabs: false, fullUrls: false, activePage: false, workspace: false, commands: false, storage: false, files: false, folders: false, secrets: false, network: false, sites: [], siteHeaders: [], control: false, state: false };

const BOOLEAN_KEYS = ["fullUrls", "activePage", "workspace", "commands", "storage", "files", "folders", "secrets", "control"] as const;

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

export const MAX_SIGN_IN_SITES = 8;

const SITE_HOST = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function siteHostProblem(host: unknown): string | null {
  if (typeof host !== "string") return "isn't text";
  if (host.length > 253 || !SITE_HOST.test(host)) return "must be an exact lowercase host with at least two parts, like www.example.com, without *, a scheme, a port or a path";
  if (/^[\d.]+$/.test(host)) return "can't be an IP address";
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "must be a public site";
  return null;
}

function sitesOf(c: Check, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SIGN_IN_SITES) {
    c.problems.push(`permissions.sites must be a list of 1 to ${MAX_SIGN_IN_SITES} hosts`);
    return [];
  }
  const hosts: string[] = [];
  value.forEach((host, i) => {
    const problem = siteHostProblem(host);
    if (problem) c.problems.push(`permissions.sites[${i}] ${problem}`);
    else if (!hosts.includes(host as string)) hosts.push(host as string);
  });
  return hosts.sort();
}

export const MAX_SITE_HEADERS = 16;

export const STANDARD_SITE_HEADERS = ["accept", "accept-language", "content-type", "cache-control", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "range"] as const;

const DASHED_HEADER = /^[a-z0-9]{1,30}(-[a-z0-9]{1,30}){1,6}$/;

const DENIED_SITE_HEADER = /^(authorization|proxy-authorization|cookie|cookie2|set-cookie|host|origin|referer|forwarded|via|connection|content-length|content-encoding|transfer-encoding|te|trailer|upgrade|keep-alive|expect|date|dnt|user-agent|accept-encoding|accept-charset|access-control-.*|sec-.*|proxy-.*|x-forwarded-.*|x-real-ip|x-http-method.*|x-method-override|x-original-url|x-rewrite-url|x-client-ip|true-client-ip|cf-connecting-ip|x-csrf-token|x-xsrf-token)$/;

export function siteHeaderNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !DASHED_HEADER.test(name)) return "must be a lowercase dashed header name, like x-example-client";
  if (DENIED_SITE_HEADER.test(name)) return "is a header Ardia sets itself or never sends for a plugin";
  if ((STANDARD_SITE_HEADERS as readonly string[]).includes(name)) return "is a standard header every site request may send already";
  return null;
}

export const isDeniedSiteHeader = (name: string) => DENIED_SITE_HEADER.test(name);

function siteHeadersPermissionOf(c: Check, value: unknown, sites: string[]): string[] {
  if (value === undefined) return [];
  if (!sites.length) {
    c.problems.push("permissions.siteHeaders needs permissions.sites");
    return [];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SITE_HEADERS) {
    c.problems.push(`permissions.siteHeaders must be a list of 1 to ${MAX_SITE_HEADERS} header names`);
    return [];
  }
  const names: string[] = [];
  value.forEach((name, i) => {
    const problem = siteHeaderNameProblem(name);
    if (problem) c.problems.push(`permissions.siteHeaders[${i}] ${problem}`);
    else if (!names.includes(name as string)) names.push(name as string);
  });
  return names.sort();
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
    else c.problems.push("permissions.tabs must be read, write or false");
  }
  for (const key of BOOLEAN_KEYS) {
    const given = value[key];
    if (given === undefined) continue;
    if (typeof given === "boolean") out[key] = given;
    else c.problems.push(`permissions.${key} must be true or false`);
  }
  out.network = networkOf(c, value.network);
  out.state = stateAccessOf(c, value.state, out.tabs);
  out.sites = sitesOf(c, value.sites);
  out.siteHeaders = siteHeadersPermissionOf(c, value.siteHeaders, out.sites);
  if (out.fullUrls && !out.tabs) c.problems.push("permissions: fullUrls needs tabs");
  if (out.workspace && (out.tabs !== "write" || !out.fullUrls)) c.problems.push("permissions: workspace needs tabs: write and fullUrls, since it sees and moves every tab");
  return out;
}

export function grantedPermissions(p: PluginPermissions): string[] {
  const out: string[] = [];
  if (p.tabs) out.push(p.tabs === "write" ? "tabs:write" : "tabs");
  for (const key of BOOLEAN_KEYS) if (p[key]) out.push(key);
  if (p.network === ANY_HOST) out.push("network");
  else if (p.network) out.push(...p.network.map((host) => `network:${host}`));
  out.push(...stateGranted(p.state));
  out.push(...p.sites.map((host) => `sites:${host}`));
  out.push(...p.siteHeaders.map((name) => `siteHeaders:${name}`));
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
  missing.push(...stateMissing(caller.state, callee.state));
  if (callee.sites.some((host) => !caller.sites.includes(host))) missing.push("sites");
  if (callee.siteHeaders.some((h) => !caller.siteHeaders.includes(h))) missing.push("siteHeaders");
  return missing;
}

export const canReadTabs = (p: PluginPermissions) => p.tabs !== false;
export const canOpenTabs = (p: PluginPermissions) => p.commands || p.tabs === "write";
export const hasNetwork = (p: PluginPermissions) => p.network !== false;
export const allowedHostsOf = (p: PluginPermissions): string[] => (p.network === false ? [] : p.network === ANY_HOST ? [ANY_HOST] : [...p.network]);
