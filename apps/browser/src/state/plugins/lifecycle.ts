import { defaultValues, rowValue } from "../../lib/pluginManifest";
import { listPluginFolders, removePluginFiles, type PluginFolderEntry } from "../../platform/plugins";
import { systemInfo } from "../../platform/app";
import { onConfigChange } from "../../platform/configFolder";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentNow, consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { listingOf } from "./appChecks";
import { applySettingsPatch, planDisable, planEnable, spliceApplied } from "./defaults";
import { pluginRecordsSaved, writePluginRecords } from "./savedState";
import { settleInstall } from "./installWaiters";
import { activeManifest, currentPlugins, isAlwaysOn, isInstalled, NO_RECORD, recordOf, usePlugins, type PluginListing, type PluginRecord } from "./store";
import { stopProcess, superviseProcess, supervisedNames } from "./process";
import { dropCalls } from "./tools";
import { sendValues } from "./channel";
import { adoptLegacyInstalls, reconcilePrograms, removePrograms } from "./programs";

export const MAX_PLUGINS = 64;

const READ_PROBLEMS: Record<Exclude<PluginFolderEntry["status"], "ok">, string> = {
  missing: "The folder has no plugin.json",
  link: "plugin.json is a link; it must be a file in the plugin's folder",
  notFile: "plugin.json isn't a file",
  tooBig: "plugin.json is over 1 MB",
  unreadable: "plugin.json couldn't be read",
};

export function listingsOf(entries: PluginFolderEntry[]): PluginListing[] {
  const settings = useBrowser.getState().settings;
  const version = systemInfo().appVersion;
  return entries
    .slice(0, MAX_PLUGINS)
    .map((e) => ({
      ...listingOf(e.name, e.status === "ok" ? (e.text ?? "") : null, e.status === "ok" ? null : READ_PROBLEMS[e.status], settings, version, e.folderId ?? ""),
      ...(e.bundled ? { bundled: true } : {}),
      ...(e.replacesBundled ? { replacesBundled: true } : {}),
      ...(e.ignoresUserFolder ? { ignoresUserFolder: true } : {}),
    }));
}

function saveRecords(records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  if (!writePluginRecords(records, consent)) return false;
  usePlugins.setState({ records });
  return true;
}

function updateRecord(name: string, change: (r: PluginRecord) => PluginRecord | null, consent: ConsentToken | null): boolean {
  const records = { ...currentPlugins().records };
  const next = change(recordOf(currentPlugins(), name));
  if (next) records[name] = next;
  else delete records[name];
  return saveRecords(records, consent);
}

export function reconcilePlugins(consent: ConsentToken | null) {
  const s = currentPlugins();
  const active = new Set<string>();
  for (const name of s.order) {
    const manifest = activeManifest(s, name);
    if (!manifest) continue;
    active.add(name);
    if (manifest.process) superviseProcess(name, s.listings[name]!.hash!, manifest, s.listings[name]!.folderId, consent);
    else stopProcess(name, consent);
  }
  for (const name of supervisedNames()) if (!active.has(name)) stopProcess(name, consent);
  reconcilePrograms(consent);
}

const toForget = new Set<string>();

function forgetRemoved(consent: ConsentToken | null) {
  for (const name of toForget) if (updateRecord(name, () => null, consent)) toForget.delete(name);
}

export function applyListings(listings: PluginListing[], consent: ConsentToken | null) {
  const byName = Object.fromEntries(listings.map((l) => [l.name, l]));
  usePlugins.setState({ listings: byName, order: listings.map((l) => l.name).sort() });
  forgetRemoved(consent);
  reconcilePlugins(consent);
  void adoptLegacyInstalls(consent).then((adopted) => adopted && reconcilePlugins(consent));
}

let scanning: Promise<void> | null = null;
let nextScan: { consent: ConsentToken | null } | null = null;

export function rescanPlugins(consent: ConsentToken | null): Promise<void> {
  if (scanning) {
    nextScan = { consent };
    return scanning;
  }
  scanning = (async () => {
    let scan: { consent: ConsentToken | null } | null = { consent };
    while (scan) {
      const asked = scan.consent;
      nextScan = null;
      const entries = await listPluginFolders().catch((error: unknown) => {
        warnFor(asked, "[plugins] couldn't list the plugins folder", error);
        return null;
      });
      if (entries) applyListings(listingsOf(entries), asked);
      closeChangedConsent();
      if (!currentPlugins().scanned) usePlugins.setState({ scanned: true });
      scan = nextScan;
    }
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

let lastConsentId = 0;

export const ALREADY_ASKING = "Ardia is already asking about a plugin. Answer that first, then try again.";

function closeChangedConsent() {
  const asked = currentPlugins().consent;
  if (!asked || currentPlugins().listings[asked.name]?.hash === asked.hash) return;
  usePlugins.setState({ consent: null });
  settleInstall(asked.name, { ok: false, reason: "It changed while installing. Try again." });
}

export function requestPluginConsent(name: string): boolean {
  const listing = currentPlugins().listings[name];
  if (currentPlugins().consent || !listing?.manifest || !listing.hash || isInstalled(currentPlugins(), name)) return false;
  usePlugins.setState({ consent: { id: ++lastConsentId, name, hash: listing.hash } });
  return true;
}

export function dismissPluginConsent(name?: string): boolean {
  const before = currentPlugins().consent;
  if (name !== undefined && before && before.name !== name) return false;
  usePlugins.setState({ consent: null });
  if (before) settleInstall(before.name, { ok: false, reason: "Cancelled.", cancelled: true });
  return true;
}

export function dismissConsentRequest(id: number): boolean {
  const asked = currentPlugins().consent;
  return asked?.id === id && dismissPluginConsent(asked.name);
}

export function confirmConsentRequest(id: number): boolean {
  const asked = currentPlugins().consent;
  return asked?.id === id && enablePlugin(asked.name, asked.hash);
}

export function enablePlugin(name: string, hash: string): boolean {
  const listing = currentPlugins().listings[name];
  const asked = currentPlugins().consent;
  if (!listing?.manifest || listing.hash !== hash || asked?.name !== name || asked.hash !== hash || removing.has(name) || isInstalled(currentPlugins(), name)) return false;
  const manifest = listing.manifest;
  const before = recordOf(currentPlugins(), name);
  const values = { ...defaultValues(manifest), ...before.values };
  const consent = consentNow();
  const kept = before.enabled && before.approved === hash;
  const records = kept || !before.enabled ? currentPlugins().records : spliceApplied(currentPlugins().records, name);
  const plan = kept ? { patch: {}, applied: before.applied } : planEnable(manifest, records, name, before.applied);
  const builtIn = isAlwaysOn(listing) ? { installed: true, ...(before.controlGranted ? { controlGranted: true } : {}) } : {};
  if (!saveRecords({ ...records, [name]: { enabled: true, approved: hash, values, applied: plan.applied, ...builtIn } }, consent)) return false;
  const asksControl = manifest.permissions.includes("control");
  applySettingsPatch(kept || !asksControl || useBrowser.getState().settings.cliControl ? plan.patch : { ...plan.patch, cliControl: true });
  usePlugins.setState({ consent: null });
  notePlugin("plugin_enables", consent);
  reconcilePlugins(consent);
  settleInstall(name, { ok: true });
  return true;
}

export function disablePlugin(name: string, consent: ConsentToken | null): boolean {
  if (isAlwaysOn(currentPlugins().listings[name])) return !isInstalled(currentPlugins(), name);
  const before = recordOf(currentPlugins(), name);
  if (!before.enabled) return true;
  const patch = planDisable(currentPlugins().records, name);
  const records = spliceApplied(currentPlugins().records, name);
  if (!saveRecords({ ...records, [name]: { ...before, enabled: false, applied: {} } }, consent)) return false;
  applySettingsPatch(patch);
  notePlugin("plugin_disables", consent);
  reconcilePlugins(consent);
  return true;
}

const removing = new Set<string>();

export async function removePlugin(name: string): Promise<{ ok: boolean; removed?: boolean; reason?: string }> {
  if (removing.has(name)) return { ok: false, reason: "It is already being removed." };
  if (currentPlugins().listings[name]?.bundled) return { ok: false, reason: isAlwaysOn(currentPlugins().listings[name]) ? "It's built into Ardia and always on." : "It's built into Ardia: turn it off instead." };
  const consent = consentToken();
  if (!disablePlugin(name, consent)) return { ok: false, reason: "It couldn't be turned off, because plugins.json couldn't be saved." };
  removing.add(name);
  try {
    if (!(await pluginRecordsSaved(consent))) return { ok: false, reason: "It couldn't be turned off, because plugins.json couldn't be saved." };
    await removePrograms(name, consent);
    const removed = await removePluginFiles(name).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (!removed.ok) return removed;
    const forgotten = updateRecord(name, () => null, consent) && (await pluginRecordsSaved(consent));
    if (!forgotten) toForget.add(name);
    await rescanPlugins(consent);
    if (!forgotten) return { ok: false, removed: true, reason: "Its files are removed, but plugins.json couldn't be updated; Ardia drops its record the next time it can save." };
    return { ok: true };
  } finally {
    removing.delete(name);
  }
}

export function setPluginValue(name: string, key: string, value: string | boolean) {
  const row = currentPlugins().listings[name]?.manifest?.settings.rows.find((r) => r.key === key);
  if (!row || rowValue(row, value) !== value) return;
  if (!updateRecord(name, (r) => ({ ...(r === NO_RECORD ? { ...NO_RECORD } : r), values: { ...r.values, [key]: value } }), consentNow())) return;
  if (activeManifest(currentPlugins(), name)) sendValues(name);
}

let started = false;

export { loadPluginRecords } from "./records";

export function watchPluginFolder() {
  if (started) return;
  started = true;
  onConfigChange(() => void rescanPlugins(consentToken()));
}
