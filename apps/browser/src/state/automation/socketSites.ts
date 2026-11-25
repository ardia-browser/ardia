import { clearSiteData, getSiteSettings, resetSiteSettings, setSiteSetting, setZoom, type SiteSettingType, type SiteSettingValue } from "../site/siteSettings";
import { getSiteSettingsOrigins, getZoomLevels, registrableDomainsOf } from "../../platform/siteSettings";
import { getContentBlocker, isContentBlockerAllowed, removeContentBlockerAllowed, setContentBlockerAllowed } from "../../platform/contentBlocker";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { refreshExtensions, reload, removeExtension, setEnabled, setPinned, findExtension } from "../extensions/actions";
import type { InstalledExtension } from "../extensions/store";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { engineArg, expect } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { askWhereSeen, shownWindowId } from "./socketAsk";

const SITE_SETTINGS = [
  "popups", "camera", "microphone", "location", "notifications", "sound", "autoplay", "javascript", "images", "clipboard", "automaticDownloads", "cookies", "midi", "sensors",
  "windowManagement", "localFonts", "idleDetection", "storageAccess", "fileSystem", "keyboardLock", "pointerLock", "cameraPanTiltZoom",
] as const satisfies readonly SiteSettingType[];
const VALUES = ["allow", "block", "ask", "default"] as const satisfies readonly SiteSettingValue[];
const ORIGIN = "^https?://[^/?#\\s]+$";

function originOf(value: unknown): string {
  let origin: string | null = null;
  try {
    origin = new URL(value as string).origin;
  } catch {
    origin = null;
  }
  if (!origin || origin !== value) throw new OpError("bad_request", `${String(value)} isn't an origin like https://example.com.`);
  return origin;
}

async function setSetting(params: Record<string, unknown>) {
  const engine = engineArg(params);
  const origin = originOf(params.origin);
  await setSiteSetting(engine, origin, params.type as SiteSettingType, params.value as SiteSettingValue);
  const after = await getSiteSettings(engine, origin);
  expect(params.value === "default" ? after[params.type as SiteSettingType].isDefault : after[params.type as SiteSettingType].value === params.value, `${params.type} didn't change for ${origin}.`);
  return after;
}

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

async function setSiteZoom(params: Record<string, unknown>) {
  const host = params.host as string;
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new OpError("bad_request", "host is a host name like example.com.");
  const engine = engineArg(params);
  await setZoom(engine, host, params.zoom as number);
  return getZoomLevels(engine);
}

function siteOf(value: unknown): string {
  const site = typeof value === "string" ? value.toLowerCase() : "";
  if (!HOST.test(site) || (!site.includes(".") && site !== "localhost")) throw new OpError("bad_request", `${String(value)} isn't a site like example.com (a host name, no scheme, port or path).`);
  return site;
}

async function clearData(params: Record<string, unknown>) {
  const site = siteOf(params.site);
  const cleared = await clearSiteData(engineArg(params), `https://${site}`);
  return { site, ...cleared };
}

const extensionRow = (x: InstalledExtension) => ({
  id: x.id,
  name: x.name,
  version: x.version,
  description: x.description,
  enabled: x.enabled,
  state: x.state,
  pinned: x.pinned,
  permissions: x.permissions,
  sites: x.sites,
  incognito: x.incognito,
  fileAccess: x.fileAccess,
  mayModify: x.mayModify,
  blockedByPolicy: !!x.blockedByPolicy,
  optionsUrl: x.optionsUrl,
  errors: x.errors,
});

async function extensionOf(params: Record<string, unknown>) {
  const engine = engineArg(params);
  const known = findExtension(engine, params.id as string) ?? (await refreshExtensions(engine)).find((x) => x.id === params.id);
  if (!known) throw new OpError("no_window", `There's no extension ${String(params.id)} in that profile.`);
  return { engine, ext: known };
}

const modifiable = (ext: InstalledExtension) => {
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
};

async function enable(params: Record<string, unknown>, call: SocketCall) {
  const { engine, ext } = await extensionOf(params);
  modifiable(ext);
  call.stillServing();
  await setEnabled(engine, ext.id, params.enabled as boolean);
  const after = (await refreshExtensions(engine)).find((x) => x.id === ext.id);
  expect(after?.enabled === params.enabled, `${ext.name} isn't ${params.enabled ? "on" : "off"}.`);
  return extensionRow(after!);
}

async function pin(params: Record<string, unknown>, call: SocketCall) {
  const { engine, ext } = await extensionOf(params);
  call.stillServing();
  const done = await setPinned(engine, ext.id, params.pinned as boolean);
  const after = (await refreshExtensions(engine)).find((x) => x.id === ext.id);
  expect(done && after?.pinned === params.pinned, `${ext.name} isn't ${params.pinned ? "pinned" : "unpinned"}.`);
  return extensionRow(after!);
}

async function uninstall(params: Record<string, unknown>, call: SocketCall) {
  const { engine, ext } = await extensionOf(params);
  modifiable(ext);
  call.stillServing();
  await removeExtension(engine, ext, shownWindowId(), call.serving, askWhereSeen(`${ext.name} wasn't removed`, call));
  const removed = !(await refreshExtensions(engine)).some((x) => x.id === ext.id);
  if (!removed) call.stillServing();
  return { removed };
}

async function adBlocker() {
  if (!PLATFORM_FEATURES.contentBlocker) throw new OpError("refused", "Ardia has no built-in ad blocker on this platform.");
  const state = await getContentBlocker();
  if (state.stats?.ready === false) throw new OpError("failed", "Ardia couldn't read the ad blocker's state; try again in a moment.");
  return { enabled: state.enabled === true, allowedSites: [...state.allowedHosts].sort() };
}

const ANY_PROFILE = "";
const NOT_HERE_YET = "This Ardia can't change the ad blocker's trusted sites from the ardia command yet; turn off Block Ads & Trackers in Site Controls for the site instead.";

const unknownCall = (error: unknown) => (error as { code?: unknown } | null)?.code === "ERR_UNKNOWN_CALL";

async function oneSiteOf(value: unknown): Promise<string> {
  const site = siteOf(value);
  const probe = `ardia-probe.${site}`;
  const { domains } = await registrableDomainsOf(ANY_PROFILE, [site, probe]).catch((error: unknown) => {
    throw new OpError(unknownCall(error) ? "refused" : "failed", unknownCall(error) ? NOT_HERE_YET : "Ardia couldn't check whether that's one site; try again.");
  });
  const registrable = Array.isArray(domains) && domains.length === 2 ? domains[0] : undefined;
  if (typeof registrable !== "string" || domains[1] !== registrable || !(site === registrable || site.endsWith(`.${registrable}`))) {
    throw new OpError("bad_request", `${site} isn't one site: it's a public suffix or an IP address, so trusting it would cover sites run by others. Give the site itself, like example.com or app.example.com.`);
  }
  return site;
}

const covering = (site: string) => `${site} and its subdomains`;

async function allowAds(params: Record<string, unknown>, call: SocketCall) {
  const site = await oneSiteOf(params.site);
  await adBlocker();
  call.stillServing();
  await setContentBlockerAllowed(site, true);
  expect(await isContentBlockerAllowed(site), `${site} isn't in the ad blocker's trusted list.`);
  return { site, trusted: true, covers: covering(site), ...(await adBlocker()) };
}

async function blockAds(params: Record<string, unknown>, call: SocketCall) {
  const site = siteOf(params.site);
  const before = await adBlocker();
  call.stillServing();
  const { removed } = await removeContentBlockerAllowed(site).catch((error: unknown) => {
    if (unknownCall(error)) throw new OpError("refused", NOT_HERE_YET);
    if ((error as { code?: unknown } | null)?.code === "ERR_PARTIAL") throw new OpError("failed", `${site} is out of the trusted list, but another open profile hasn't followed yet; run blockAds again to bring it in line.`);
    throw error;
  });
  if (!removed) {
    const broader = before.allowedSites.find((entry) => site.endsWith(`.${entry}`));
    throw new OpError(
      "refused",
      broader ? `${site} isn't in the trusted list itself; ${broader} is, and covers it. Block ads on ${broader} to take that entry out.` : `${site} isn't in the ad blocker's trusted list.`,
    );
  }
  const after = await adBlocker();
  expect(!after.allowedSites.includes(site), `${site} is still in the ad blocker's trusted list.`);
  const stillCoveredBy = after.allowedSites.find((entry) => site.endsWith(`.${entry}`));
  return { site, removed: true, trusted: !!stillCoveredBy, ...(stillCoveredBy ? { coveredBy: stillCoveredBy } : {}), ...after };
}

const EXTENSION = { profile: PROFILE, id: id("An extension id from extensions.list") };
const SITE = { profile: PROFILE, origin: { type: "string", pattern: ORIGIN, description: "An origin like https://example.com" } as const };

export const SITE_METHODS: MethodSpec[] = [
  { name: "sites.origins", mutates: false, description: "Origins with their own site settings", params: obj({ profile: PROFILE }), result: "[origin]", run: (p) => getSiteSettingsOrigins(engineArg(p)) },
  { name: "sites.get", mutates: false, description: "An origin's settings and permissions: camera, location, notifications, pop-ups, JavaScript, sound, …", params: obj(SITE, ["origin"]), result: "{type: {value, isDefault}}", run: (p) => getSiteSettings(engineArg(p), originOf(p.origin)) },
  {
    name: "sites.set",
    mutates: true,
    description: "Allow, block or ask for one permission on an origin, or put it back to the default",
    params: obj({ ...SITE, type: oneOf(SITE_SETTINGS, "Which setting"), value: oneOf(VALUES, "allow, block, ask or default") }, ["origin", "type", "value"]),
    result: "{type: {value, isDefault}}",
    run: setSetting,
  },
  {
    name: "sites.reset",
    mutates: true,
    description: "Put every setting of an origin back to the default",
    params: obj(SITE, ["origin"]),
    result: "{ok}",
    run: async (p) => {
      await resetSiteSettings(engineArg(p), originOf(p.origin));
      return { ok: true };
    },
  },
  {
    name: "sites.clearData",
    mutates: true,
    description: "Delete a whole site's cookies and stored data: its registrable domain and every subdomain, over http and https (mail.example.com clears all of example.com)",
    params: obj({ profile: PROFILE, site: text("A host like example.com; the whole site it belongs to is cleared") }, ["site"]),
    result: "{site, cookies, storage}",
    run: clearData,
  },
  { name: "sites.adBlocker", mutates: false, description: "The built-in ad blocker (uBlock Origin): whether it's on and the sites it lets through", params: obj({}), result: "{enabled, allowedSites}", run: adBlocker },
  {
    name: "sites.allowAds",
    mutates: true,
    description: "Add a site to the built-in ad blocker's trusted list, as turning off Block Ads & Trackers in Site Controls does: it covers the site's subdomains, in every profile, from the next page load. A public suffix or IP address is refused",
    params: obj({ site: text("A host like example.com: no scheme, port, path or wildcard") }, ["site"]),
    result: "{site, trusted, covers, enabled, allowedSites}",
    run: allowAds,
  },
  {
    name: "sites.blockAds",
    mutates: true,
    description: "Take a site out of the built-in ad blocker's trusted list. Only that entry goes: an entry sites.adBlocker lists, never a broader one or one uBlock ships with. trusted says whether a broader entry (coveredBy) still lets the site through",
    params: obj({ site: text("A host like example.com: no scheme, port, path or wildcard") }, ["site"]),
    result: "{site, removed, trusted, coveredBy?, enabled, allowedSites}",
    run: blockAds,
  },
  { name: "sites.zoomLevels", mutates: false, description: "Zoom per host", params: obj({ profile: PROFILE }), result: "{host: zoom}", run: (p) => getZoomLevels(engineArg(p)) },
  { name: "sites.setZoom", mutates: true, description: "Set a host's zoom (1 is 100%)", params: obj({ profile: PROFILE, host: text("A host like example.com"), zoom: { type: "number", minimum: 0.25, maximum: 5, description: "1 is 100%" } }, ["host", "zoom"]), result: "{host: zoom}", run: setSiteZoom },
  { name: "extensions.list", mutates: false, description: "A profile's extensions", params: obj({ profile: PROFILE }), result: "[extension]", run: async (p) => (await refreshExtensions(engineArg(p))).map(extensionRow) },
  { name: "extensions.setEnabled", mutates: true, description: "Turn an extension on or off", params: obj({ ...EXTENSION, enabled: bool("On or off") }, ["id", "enabled"]), result: "extension", run: enable },
  { name: "extensions.setPinned", mutates: true, description: "Show or hide an extension in the toolbar", params: obj({ ...EXTENSION, pinned: bool("In the toolbar") }, ["id", "pinned"]), result: "extension", run: pin },
  {
    name: "extensions.reload",
    mutates: true,
    description: "Reload an extension",
    params: obj(EXTENSION, ["id"]),
    result: "{ok}",
    run: async (p, call) => {
      const { engine, ext } = await extensionOf(p);
      call.stillServing();
      expect(await reload(engine, ext.id), `${ext.name} didn't reload.`);
      return { ok: true };
    },
  },
  { name: "extensions.uninstall", mutates: true, description: "Remove an extension; Ardia asks the user to confirm first", params: obj(EXTENSION, ["id"]), result: "{removed}", run: uninstall },
];
