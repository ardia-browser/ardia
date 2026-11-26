import { documentSaved, readDocument, writeDocument } from "../../platform/documents";
import { isFields, type Fields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { KEY_PATTERN } from "../../lib/pluginManifest";
import { isSemver } from "@ardia/plugin-sdk/semver";
import { PLUGIN_KEY } from "../../lib/pluginIds";
import type { PendingUpdate, PluginRecord, PluginRevoked, PluginUpdateNote, SiteSwitchValues } from "./store";
import { switchOrigin } from "../../lib/pluginPageBar";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";

export const PLUGINS_DOC = "Plugins/plugins-state.json";
export const LEGACY_PLUGINS_DOC = "plugins.json";
const VERSION = 1;
const NAME = PLUGIN_KEY;
const PROFILE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PROFILES = 64;

const HASH = /^[0-9a-f]{64}$/;

function valuesOf(raw: unknown): Record<string, string | boolean | number> {
  if (!isFields(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string | boolean | number] => typeof e[1] === "string" || typeof e[1] === "boolean" || (typeof e[1] === "number" && Number.isFinite(e[1]))));
}

function appliedOf(raw: unknown): PluginRecord["applied"] {
  if (!isFields(raw)) return {};
  const out: PluginRecord["applied"] = {};
  for (const [key, entry] of Object.entries(raw)) if (isFields(entry) && Object.hasOwn(entry, "value")) out[key] = { value: entry.value, previous: entry.previous, order: typeof entry.order === "number" && Number.isSafeInteger(entry.order) ? entry.order : 0, over: typeof entry.over === "string" && NAME.test(entry.over) ? entry.over : null };
  return out;
}

const KEY = new RegExp(KEY_PATTERN);

function sitesOf(raw: unknown): SiteSwitchValues | null {
  if (!isFields(raw)) return null;
  const entries = Object.entries(raw).flatMap(([key, origins]): [string, Record<string, boolean>][] => {
    if (!KEY.test(key) || !isFields(origins)) return [];
    const kept = Object.entries(origins).filter((e): e is [string, boolean] => typeof e[1] === "boolean" && switchOrigin(e[0]) === e[0]);
    return kept.length ? [[key, Object.fromEntries(kept)]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

export const MAX_UPDATE_LINES = 24;
const MAX_UPDATE_LINE = 600;
const MAX_REASON = 1000;

const versionOf = (raw: unknown): string | null => (typeof raw === "string" && isSemver(raw) ? raw : null);

const linesOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((line): line is string => typeof line === "string" && line.length > 0 && line.length <= MAX_UPDATE_LINE).slice(0, MAX_UPDATE_LINES) : [];

function updatedOf(raw: unknown): PluginUpdateNote | null {
  if (!isFields(raw) || !Array.isArray(raw.added)) return null;
  return { from: versionOf(raw.from), to: versionOf(raw.to), added: linesOf(raw.added), ...(raw.runtime === true ? { runtime: true as const } : {}), ...(raw.rolledBack === true ? { rolledBack: true as const } : {}) };
}

const STORE_FOLDER = /^store-[0-9a-f]{64}$/;
const BUNDLED_NAME = /^[a-z0-9][a-z0-9-]{0,39}__[a-z0-9][a-z0-9-]{0,39}$/;

function bundleOf(raw: unknown): PendingUpdate["bundle"] {
  if (!Array.isArray(raw)) return undefined;
  const bundle = raw
    .filter((b): b is { name: string; folderId: string } => isFields(b) && typeof b.name === "string" && BUNDLED_NAME.test(b.name) && typeof b.folderId === "string" && STORE_FOLDER.test(b.folderId))
    .slice(0, MAX_UPDATE_LINES)
    .map((b) => ({ name: b.name, folderId: b.folderId }));
  return bundle.length ? bundle : undefined;
}

function pendingOf(raw: unknown): PendingUpdate | null {
  if (!isFields(raw)) return null;
  const version = versionOf(raw.version);
  if (!version || typeof raw.folderId !== "string" || !STORE_FOLDER.test(raw.folderId)) return null;
  const bundle = bundleOf(raw.bundle);
  return { version, folderId: raw.folderId, added: linesOf(raw.added), dependencies: linesOf(raw.dependencies), ...(bundle ? { bundle } : {}) };
}

function revokedOf(raw: unknown): PluginRevoked | null {
  if (!isFields(raw) || (raw.action !== "disable" && raw.action !== "block") || typeof raw.reason !== "string") return null;
  return { action: raw.action, reason: raw.reason.slice(0, MAX_REASON), ...(typeof raw.version === "string" && isSemver(raw.version) ? { version: raw.version } : {}) };
}

function profilesOf(raw: unknown): PluginRecord["profiles"] | null {
  if (raw === "all") return "all";
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && PROFILE_ID.test(id)))].slice(0, MAX_PROFILES);
}

export function parsePluginRecords(json: string | null): Record<string, PluginRecord> {
  const doc = parseSaved(json, VERSION);
  if (!doc || !isFields(doc.plugins)) return {};
  const out: Record<string, PluginRecord> = {};
  for (const [name, raw] of Object.entries(doc.plugins as Fields)) {
    if (!NAME.test(name) || !isFields(raw)) continue;
    const approved = typeof raw.approved === "string" && HASH.test(raw.approved) ? raw.approved : null;
    out[name] = { enabled: raw.enabled === true && approved !== null, approved, values: valuesOf(raw.values), applied: appliedOf(raw.applied), ...(raw.controlGranted === true ? { controlGranted: true } : {}), ...(raw.installed === true ? { installed: true } : {}), ...(typeof raw.previous === "string" && HASH.test(raw.previous) ? { previous: raw.previous } : {}) };
    const sites = sitesOf(raw.sites);
    if (sites) out[name]!.sites = sites;
    const updated = updatedOf(raw.updated);
    if (updated) out[name]!.updated = updated;
    const pending = pendingOf(raw.pendingUpdate);
    if (pending) out[name]!.pendingUpdate = pending;
    const revoked = revokedOf(raw.revoked);
    if (revoked) out[name]!.revoked = revoked;
    const profiles = profilesOf(raw.profiles);
    if (profiles) out[name]!.profiles = profiles;
    if (raw.preapproved === true) out[name]!.preapproved = true;
  }
  return out;
}

export type CustomRegistry = { url: string; scopes: string[]; keys: Record<string, string> };

export type PluginsExtras = { registries: CustomRegistry[]; migrated: string[] };

const NO_EXTRAS: PluginsExtras = { registries: [], migrated: [] };

let extras: PluginsExtras = NO_EXTRAS;

const SCOPE = /^@[a-z0-9][a-z0-9-]{0,38}$/;
const MAX_REGISTRIES = 16;

function registriesOf(raw: unknown): CustomRegistry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): CustomRegistry[] => {
    if (!isFields(entry) || typeof entry.url !== "string" || !/^https:\/\/[^\s]{1,2000}$/.test(entry.url)) return [];
    const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter((scope): scope is string => typeof scope === "string" && SCOPE.test(scope)) : [];
    const keys = isFields(entry.keys) ? Object.fromEntries(Object.entries(entry.keys).filter((e): e is [string, string] => /^[A-Za-z0-9._:-]{1,128}$/.test(e[0]) && typeof e[1] === "string" && e[1].length <= 4096)) : {};
    return [{ url: entry.url, scopes: [...new Set(scopes)], keys }];
  }).slice(0, MAX_REGISTRIES);
}

export function parsePluginsExtras(json: string | null): PluginsExtras {
  const doc = parseSaved(json, VERSION);
  if (!doc) return NO_EXTRAS;
  const migrated = Array.isArray(doc.migrated) ? doc.migrated.filter((name): name is string => typeof name === "string" && NAME.test(name)) : [];
  return { registries: registriesOf(doc.registries), migrated: [...new Set(migrated)] };
}

export const pluginsExtras = (): PluginsExtras => extras;

export const pluginRecordsJson = (records: Record<string, PluginRecord>, given: PluginsExtras = extras) =>
  versionedJson({ plugins: records, registries: given.registries, migrated: given.migrated }, VERSION);

export function loadPluginsExtras() {
  try {
    extras = parsePluginsExtras(readDocument(PLUGINS_DOC));
  } catch {
    extras = NO_EXTRAS;
  }
}

export function writePluginsExtras(next: PluginsExtras, records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  try {
    writeDocument(PLUGINS_DOC, pluginRecordsJson(records, next));
    extras = next;
    return true;
  } catch (error) {
    warnFor(consent, "[plugins] couldn't save plugins-state.json", error);
    return false;
  }
}

export const resetPluginsExtrasForTests = () => void (extras = NO_EXTRAS);

export function readPluginRecords(): Record<string, PluginRecord> {
  try {
    const current = readDocument(PLUGINS_DOC);
    return parsePluginRecords(current ?? readDocument(LEGACY_PLUGINS_DOC));
  } catch {
    return {};
  }
}

export function writePluginRecords(records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  try {
    writeDocument(PLUGINS_DOC, pluginRecordsJson(records));
    return true;
  } catch (error) {
    warnFor(consent, "[plugins] couldn't save plugins-state.json", error);
    return false;
  }
}

export const pluginRecordsSaved = (consent: ConsentToken | null): Promise<boolean> =>
  documentSaved(PLUGINS_DOC).then(
    () => true,
    (error: unknown) => {
      warnFor(consent, "[plugins] couldn't save plugins-state.json", error);
      return false;
    },
  );
