import { engineProfile } from "../browser/model";
import { clearSiteData, getSiteSettings, resetSiteSettings, setSiteSetting, setZoom, type SiteSettingType, type SiteSettingValue } from "../site/siteSettings";
import { getSiteSettingsOrigins, getZoomLevels } from "../../platform/siteSettings";
import { refreshExtensions, reload, removeExtension, setEnabled, setPinned, findExtension } from "../extensions/actions";
import type { InstalledExtension } from "../extensions/store";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { expect, now, profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { askWhereSeen, shownWindowId } from "./socketAsk";
import { t } from "../../lib/uiLanguage";


const SITE_SETTINGS = [
  "popups", "camera", "microphone", "location", "notifications", "sound", "autoplay", "javascript", "images", "clipboard", "automaticDownloads", "cookies", "midi", "sensors",
  "windowManagement", "localFonts", "idleDetection", "storageAccess", "fileSystem", "keyboardLock", "pointerLock", "cameraPanTiltZoom",
] as const satisfies readonly SiteSettingType[];
const VALUES = ["allow", "block", "ask", "default"] as const satisfies readonly SiteSettingValue[];
const ORIGIN = "^https?://[^/?#\\s]+$";

const engineOf = (params: Record<string, unknown>) => engineProfile(now(), profileArg(params.profile));

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
  const engine = engineOf(params);
  const origin = originOf(params.origin);
  await setSiteSetting(engine, origin, params.type as SiteSettingType, params.value as SiteSettingValue);
  const after = await getSiteSettings(engine, origin);
  expect(params.value === "default" ? after[params.type as SiteSettingType].isDefault : after[params.type as SiteSettingType].value === params.value, `${params.type} didn't change for ${origin}.`);
  return after;
}

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

async function setSiteZoom(params: Record<string, unknown>) {
  const host = params.host as string;
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new OpError("bad_request", t(`host is a host name like example.com.`));
  const engine = engineOf(params);
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
  const cleared = await clearSiteData(engineOf(params), `https://${site}`);
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
  const engine = engineOf(params);
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

const EXTENSION = { profile: PROFILE, id: id(t(`An extension id from extensions.list`)) };
const SITE = { profile: PROFILE, origin: { type: "string", pattern: ORIGIN, description: "An origin like https://example.com" } as const };

export const SITE_METHODS: MethodSpec[] = [
  { name: "sites.origins", mutates: false, description: t(`Origins with their own site settings`), params: obj({ profile: PROFILE }), result: "[origin]", run: (p) => getSiteSettingsOrigins(engineOf(p)) },
  { name: "sites.get", mutates: false, description: t(`An origin's settings and permissions: camera, location, notifications, pop-ups, JavaScript, sound, …`), params: obj(SITE, ["origin"]), result: t(`{type: {value, isDefault}}`), run: (p) => getSiteSettings(engineOf(p), originOf(p.origin)) },
  {
    name: "sites.set",
    mutates: true,
    description: t(`Allow, block or ask for one permission on an origin, or put it back to the default`),
    params: obj({ ...SITE, type: oneOf(SITE_SETTINGS, t(`Which setting`)), value: oneOf(VALUES, t(`allow, block, ask or default`)) }, ["origin", "type", "value"]),
    result: t(`{type: {value, isDefault}}`),
    run: setSetting,
  },
  {
    name: "sites.reset",
    mutates: true,
    description: t(`Put every setting of an origin back to the default`),
    params: obj(SITE, ["origin"]),
    result: "{ok}",
    run: async (p) => {
      await resetSiteSettings(engineOf(p), originOf(p.origin));
      return { ok: true };
    },
  },
  {
    name: "sites.clearData",
    mutates: true,
    description: t(`Delete a whole site's cookies and stored data: its registrable domain and every subdomain, over http and https (mail.example.com clears all of example.com)`),
    params: obj({ profile: PROFILE, site: text(t(`A host like example.com; the whole site it belongs to is cleared`)) }, ["site"]),
    result: t(`{site, cookies, storage}`),
    run: clearData,
  },
  { name: "sites.zoomLevels", mutates: false, description: t(`Zoom per host`), params: obj({ profile: PROFILE }), result: t(`{host: zoom}`), run: (p) => getZoomLevels(engineOf(p)) },
  { name: "sites.setZoom", mutates: true, description: t(`Set a host's zoom (1 is 100%)`), params: obj({ profile: PROFILE, host: text(t(`A host like example.com`)), zoom: { type: "number", minimum: 0.25, maximum: 5, description: t(`1 is 100%`) } }, ["host", "zoom"]), result: t(`{host: zoom}`), run: setSiteZoom },
  { name: "extensions.list", mutates: false, description: t(`A profile's extensions`), params: obj({ profile: PROFILE }), result: "[extension]", run: async (p) => (await refreshExtensions(engineOf(p))).map(extensionRow) },
  { name: "extensions.setEnabled", mutates: true, description: t(`Turn an extension on or off`), params: obj({ ...EXTENSION, enabled: bool(t(`On or off`)) }, ["id", "enabled"]), result: "extension", run: enable },
  { name: "extensions.setPinned", mutates: true, description: t(`Show or hide an extension in the toolbar`), params: obj({ ...EXTENSION, pinned: bool(t(`In the toolbar`)) }, ["id", "pinned"]), result: "extension", run: pin },
  {
    name: "extensions.reload",
    mutates: true,
    description: t(`Reload an extension`),
    params: obj(EXTENSION, ["id"]),
    result: "{ok}",
    run: async (p, call) => {
      const { engine, ext } = await extensionOf(p);
      call.stillServing();
      expect(await reload(engine, ext.id), `${ext.name} didn't reload.`);
      return { ok: true };
    },
  },
  { name: "extensions.uninstall", mutates: true, description: t(`Remove an extension; Ardia asks the user to confirm first`), params: obj(EXTENSION, ["id"]), result: "{removed}", run: uninstall },
];
