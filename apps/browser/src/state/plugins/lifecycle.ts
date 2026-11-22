import { defaultValues, rowValue } from "../../lib/pluginManifest";
import { listPluginFolders, removePluginFiles, type PluginFolderEntry } from "../../platform/plugins";
import { systemInfo } from "../../platform/app";
import { onConfigChange } from "../../platform/configFolder";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentNow, consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { listingOf, NO_CLAIMS, type ProgramClaims } from "./appChecks";
import { loadProgramClaims } from "./programRegistry";
import { programControlOn, userTurnedControlOff } from "../app/programControlSetting";
import { applySettingsPatch, planDisable, planEnable, spliceApplied } from "./defaults";
import { pluginRecordsSaved, writePluginRecords } from "./savedState";
import { settleInstall } from "./installWaiters";
import { abandonWithdrawal, activeManifest, approvalMatches, setOfficialFetch, commitPlugins, consentListing, currentPlugins, withdrawalsFor, type PluginsCommit, keepsInstalledFlag, NO_RECORD, recordApproves, recordOf, usePlugins, type PluginListing, type PluginRecord } from "./store";
import { officialPluginsPinned, promoteOfficialPlugin } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { pluginsScanned } from "./scanListeners";
import { stopProcess, superviseProcess, supervisedNames } from "./process";
import { checkActivations, deactivatePlugin, shouldRun } from "./activation";
import { clearPluginSurfaces } from "./surfaces";
import { clearPluginSecrets, type SecretsCleared } from "./secrets";
import { closePluginStorage, reopenPluginStorage } from "./storage";
import { forgetPluginGestures } from "./gestures";
import { dropCalls } from "./tools";
import { sendValues } from "./channel";
import { adoptLegacyInstalls, reconcilePrograms, removePrograms } from "./programs";
import { isBundledRetiredRecord, noteRetiredRecords, RETIRED_OFFICIAL_PLUGINS } from "./retiredOfficial";
import { t } from "../../lib/uiLanguage";


export const MAX_PLUGINS = 64;

const READ_PROBLEMS: Record<Exclude<PluginFolderEntry["status"], "ok">, string> = {
  missing: t(`The folder has no plugin.json`),
  link: t(`plugin.json is a link; it must be a file in the plugin's folder`),
  notFile: t(`plugin.json isn't a file`),
  tooBig: t(`plugin.json is over 1 MB`),
  unreadable: t(`plugin.json couldn't be read`),
};

const officialFlags = (e: PluginFolderEntry): Partial<PluginListing> => ({
  ...(e.official ? { official: true } : {}),
  ...(e.official && e.legacy ? { legacy: true } : {}),
  ...(e.official && e.legacyHash ? { legacyHash: e.legacyHash } : {}),
  ...(e.ignoresUserFolder ? { ignoresUserFolder: true } : {}),
});

export function listingsOf(entries: PluginFolderEntry[], registry: ProgramClaims = NO_CLAIMS): PluginListing[] {
  const settings = useBrowser.getState().settings;
  const version = systemInfo().appVersion;
  return entries
    .filter((e) => !e.candidateOnly)
    .slice(0, MAX_PLUGINS)
    .map((e) => ({
      ...listingOf(e.name, e.status === "ok" ? (e.text ?? "") : null, e.status === "ok" ? null : READ_PROBLEMS[e.status], settings, version, e.folderId ?? "", registry),
      ...officialFlags(e),
    }));
}

export function candidatesOf(entries: PluginFolderEntry[], registry: ProgramClaims = NO_CLAIMS): PluginListing[] {
  const settings = useBrowser.getState().settings;
  const version = systemInfo().appVersion;
  return entries.flatMap((e) => {
    if (!e.official || !e.candidate) return [];
    const c = e.candidate;
    return [{ ...listingOf(e.name, c.text, null, settings, version, c.folderId, registry), official: true, legacyHash: c.legacyHash }];
  });
}

export const keptLegacy = (listing: PluginListing, records: Record<string, PluginRecord>) =>
  !listing.legacy || (Object.hasOwn(records, listing.name) && recordApproves(listing, records[listing.name]));

function saveRecords(records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  if (!writePluginRecords(records, consent)) return false;
  noteRetiredRecords(currentPlugins().records, records);
  commitPlugins({ records });
  return true;
}

function updateRecord(name: string, change: (r: PluginRecord) => PluginRecord | null, consent: ConsentToken | null): boolean {
  const records = { ...currentPlugins().records };
  const next = change(recordOf(currentPlugins(), name));
  if (next) records[name] = next;
  else delete records[name];
  return saveRecords(records, consent);
}

let lastActive = new Set<string>();

function withdrawn(active: Set<string>): string[] {
  const gone = [...lastActive].filter((name) => !active.has(name));
  lastActive = new Set(active);
  return gone;
}

export function reconcilePlugins(consent: ConsentToken | null) {
  const s = currentPlugins();
  const active = new Set<string>();
  for (const name of s.order) {
    const manifest = activeManifest(s, name);
    if (!manifest) continue;
    active.add(name);
    const listing = s.listings[name]!;
    if (shouldRun(name, listing.hash!, manifest)) superviseProcess(name, listing.hash!, manifest, listing.folderId, consent);
    else stopProcess(name, consent);
  }
  for (const name of supervisedNames()) if (!active.has(name)) stopProcess(name, consent);
  for (const name of withdrawn(active)) {
    deactivatePlugin(name);
    clearPluginSurfaces(name);
    forgetPluginGestures(name);
  }
  checkActivations();
  reconcilePrograms(consent);
}

const toForget = new Set<string>();

function forgetRemoved(consent: ConsentToken | null) {
  for (const name of toForget) if (updateRecord(name, () => null, consent)) toForget.delete(name);
  const s = currentPlugins();
  for (const name of Object.keys(RETIRED_OFFICIAL_PLUGINS)) {
    const record = s.records[name];
    if (!record || s.listings[name] || !isBundledRetiredRecord(name, record)) continue;
    updateRecord(name, () => null, consent);
  }
}

export const WITHDRAW_DEADLINE_MS = 1000;

export function withdrawBefore(next: PluginsCommit, consent: ConsentToken | null): Promise<void> | null {
  const waits = withdrawalsFor(next).map((w) => w.then(() => "done" as const, () => "done" as const));
  if (!waits.length) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), WITHDRAW_DEADLINE_MS)));
  return Promise.race([Promise.all(waits).then(() => "done" as const), late]).then((outcome) => {
    clearTimeout(timer);
    if (outcome === "late") warnFor(consent, `[plugins] native didn't confirm a withdrawal within ${WITHDRAW_DEADLINE_MS} ms; going ahead`);
  });
}

const listingsByName = (listings: PluginListing[]) => Object.fromEntries(listings.map((l) => [l.name, l]));

export function applyListings(given: PluginListing[], consent: ConsentToken | null, candidates?: PluginListing[]) {
  const records = currentPlugins().records;
  const listings = given.filter((l) => keptLegacy(l, records));
  const byName = listingsByName(listings);
  if (candidates) usePlugins.setState({ candidates: listingsByName(candidates) });
  commitPlugins({ listings: byName, order: listings.map((l) => l.name).sort() });
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
        warnFor(asked, t(`[plugins] couldn't list the plugins folder`), error);
        return null;
      });
      if (entries && currentPlugins().pinned === null) {
        const pinned = PLATFORM_FEATURES.plugins ? await officialPluginsPinned().catch(() => null) : null;
        usePlugins.setState({ pinned: pinned ?? [] });
      }
      if (entries) {
        const claims = await loadProgramClaims();
        const listings = listingsOf(entries, claims).filter((l) => keptLegacy(l, currentPlugins().records));
        const withdrawing = withdrawBefore({ listings: listingsByName(listings), records: currentPlugins().records }, asked);
        if (withdrawing) await withdrawing;
        applyListings(listings, asked, candidatesOf(entries, claims));
        pluginsScanned(asked);
      }
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

export const ALREADY_ASKING = t(`Ardia is already asking about a plugin. Answer that first, then try again.`);

function closeChangedConsent() {
  const asked = currentPlugins().consent;
  if (!asked || consentListing(currentPlugins(), asked.name, asked.hash)?.hash === asked.hash) return;
  usePlugins.setState({ consent: null });
  settleInstall(asked.name, { ok: false, reason: t(`It changed while installing. Try again.`) });
}

export function consentTarget(name: string, official = false): PluginListing | undefined {
  const s = currentPlugins();
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  if (!official && listing && !listing.official) return listing;
  const candidate = Object.hasOwn(s.candidates, name) ? s.candidates[name] : undefined;
  if (candidate?.manifest && candidate.hash) return candidate;
  if (official && !listing?.official) return undefined;
  if (listing?.legacy) return undefined;
  return listing;
}

export function requestPluginConsent(name: string, official = false): boolean {
  const target = consentTarget(name, official);
  if (currentPlugins().consent || !target?.manifest || !target.hash) return false;
  usePlugins.setState({ consent: { id: ++lastConsentId, name, hash: target.hash } });
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
  const matched = consentListing(currentPlugins(), name, hash);
  const listing = matched?.legacy ? undefined : matched;
  const asked = currentPlugins().consent;
  if (!listing?.manifest || listing.hash !== hash || asked?.name !== name || asked.hash !== hash || removing.has(name)) return false;
  const candidate = currentPlugins().candidates[name] === listing;
  const manifest = listing.manifest;
  const before = recordOf(currentPlugins(), name);
  const values = { ...defaultValues(manifest), ...before.values };
  const consent = consentNow();
  const kept = before.enabled && approvalMatches(listing, before.approved);
  const records = kept || !before.enabled ? currentPlugins().records : spliceApplied(currentPlugins().records, name);
  const plan = kept ? { patch: {}, applied: before.applied } : planEnable(manifest, records, name, before.applied);
  const builtIn = keepsInstalledFlag(listing) ? { installed: true, ...(before.controlGranted ? { controlGranted: true } : {}) } : {};
  const current = currentPlugins().listings[name];
  const previous = candidate && recordApproves(current, before) ? (approvalMatches(current, before.approved) ? before.approved : before.previous) : undefined;
  if (!saveRecords({ ...records, [name]: { enabled: true, approved: hash, values, applied: plan.applied, ...builtIn, ...(previous ? { previous } : {}) } }, consent)) return false;
  if (candidate) void promoteCandidate(name, listing, consent);
  const asksControl = manifest.permissions.control;
  applySettingsPatch(kept || !asksControl || programControlOn(useBrowser.getState()) || userTurnedControlOff() ? plan.patch : { ...plan.patch, cliControl: true });
  usePlugins.setState({ consent: null });
  notePlugin("plugin_enables", consent);
  reconcilePlugins(consent);
  settleInstall(name, { ok: true });
  return true;
}

export const PROMOTION_RETRY = { delayMs: 60_000 };

export function adoptExactApproval(name: string, candidate: PluginListing, consent: ConsentToken | null): boolean {
  const before = recordOf(currentPlugins(), name);
  if (!candidate.hash || !approvalMatches(candidate, before.approved)) return false;
  if (before.approved === candidate.hash) return true;
  return saveRecords({ ...currentPlugins().records, [name]: { ...before, approved: candidate.hash, previous: before.approved! } }, consent);
}

export async function promoteCandidate(name: string, candidate: PluginListing, consent: ConsentToken | null): Promise<boolean> {
  setOfficialFetch(name, { state: "promoting" });
  const exact = adoptExactApproval(name, candidate, consent);
  const saved = exact && (await pluginRecordsSaved(consent));
  const record = recordOf(currentPlugins(), name);
  if (!saved || !record.enabled || !approvalMatches(candidate, record.approved)) {
    setOfficialFetch(name, { state: "failed", code: "failed", reason: saved ? t(`Its approval changed before it could be switched to.`) : t(`plugins.json couldn't be saved.`) });
    return false;
  }
  const promoted = await promoteOfficialPlugin(name, candidate.folderId, candidate.hash!).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!promoted.ok) warnFor(consent, `[plugins] ${name}'s download couldn't be switched to: ${promoted.reason}`);
  await rescanPlugins(consent);
  setOfficialFetch(name, promoted.ok ? null : { state: "failed", code: "failed", reason: promoted.reason });
  if (!promoted.ok) setTimeout(() => void rescanPlugins(consent), PROMOTION_RETRY.delayMs);
  return promoted.ok;
}

export function turnOnApprovedPlugin(name: string): boolean {
  const s = currentPlugins();
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  const before = recordOf(s, name);
  if (!listing?.manifest || before.enabled || !recordApproves(listing, before) || removing.has(name) || s.consent) return false;
  const consent = consentNow();
  const plan = planEnable(listing.manifest, s.records, name, before.applied);
  const installed = keepsInstalledFlag(listing) ? { installed: true } : {};
  if (!saveRecords({ ...s.records, [name]: { ...before, enabled: true, applied: plan.applied, ...installed } }, consent)) return false;
  applySettingsPatch(plan.patch);
  notePlugin("plugin_enables", consent);
  reconcilePlugins(consent);
  return true;
}

export function disablePlugin(name: string, consent: ConsentToken | null): boolean {
  const before = recordOf(currentPlugins(), name);
  if (!before.enabled) return true;
  const patch = planDisable(currentPlugins().records, name);
  const records = spliceApplied(currentPlugins().records, name);
  const { installed: _installed, ...kept } = before;
  if (!saveRecords({ ...records, [name]: { ...kept, enabled: false, applied: {} } }, consent)) return false;
  applySettingsPatch(patch);
  notePlugin("plugin_disables", consent);
  reconcilePlugins(consent);
  return true;
}

export function turnOffPlugin(name: string, consent: ConsentToken | null): Promise<boolean> {
  const before = recordOf(currentPlugins(), name);
  const withdrawing = before.enabled ? withdrawBefore({ listings: currentPlugins().listings, records: { ...currentPlugins().records, [name]: { ...before, enabled: false } } }, consent) : null;
  if (!withdrawing) return Promise.resolve(disablePlugin(name, consent));
  return withdrawing.then(() => {
    if (disablePlugin(name, consent)) return true;
    abandonWithdrawal(name, consent);
    return false;
  });
}

const removing = new Set<string>();

const secretsLeftReason = (name: string, secrets: SecretsCleared) =>
  `Its files are removed, but ${secrets.remaining.length === 1 ? "1 secret is" : secrets.remaining.length ? `${secrets.remaining.length} secrets are` : "its secrets may be"} still in your Keychain, under ardia.plugin.${name}. Delete them in Keychain Access.`;

export type RemovalIdentity = { official: boolean; folderId: string | null };

export function removalIdentity(name: string): RemovalIdentity {
  const listed = Object.hasOwn(currentPlugins().listings, name) ? currentPlugins().listings[name] : undefined;
  const official = listed ? !!listed.official : !!currentPlugins().pinned?.some((p) => p.name === name) || Object.hasOwn(currentPlugins().candidates, name);
  return { official, folderId: listed?.folderId || null };
}

export async function removePlugin(name: string, mayGoOn: () => boolean = () => true, expected?: RemovalIdentity): Promise<{ ok: boolean; removed?: boolean; reason?: string }> {
  if (removing.has(name)) return { ok: false, reason: t(`It is already being removed.`) };
  const identity = removalIdentity(name);
  const official = identity.official;
  if (expected && (expected.official !== identity.official || expected.folderId !== identity.folderId)) return { ok: false, reason: t(`It changed while you were deciding. Try again.`) };
  const consent = consentToken();
  removing.add(name);
  try {
    if (!(await turnOffPlugin(name, consent))) return { ok: false, reason: t(`It couldn't be turned off, because plugins.json couldn't be saved.`) };
    if (!(await pluginRecordsSaved(consent))) return { ok: false, reason: t(`It couldn't be turned off, because plugins.json couldn't be saved.`) };
    if (!mayGoOn()) return { ok: false, reason: t(`Control was turned off after Ardia turned it off, so its files are still there.`) };
    await removePrograms(name, consent);
    if (!mayGoOn()) return { ok: false, reason: t(`Control was turned off after Ardia unlinked its programs, so its files are still there.`) };
    await closePluginStorage(name);
    const now = removalIdentity(name);
    if (expected && (now.official !== official || (!official && expected.folderId !== null && now.folderId !== null && now.folderId !== expected.folderId)))
      return { ok: false, reason: t(`It changed while it was being removed, so its files are still there. Try again.`) };
    const removed = await removePluginFiles(name, official, official ? null : (expected?.folderId ?? identity.folderId)).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (!removed.ok) return removed;
    const secrets = official ? { ok: true, remaining: [] } : await clearPluginSecrets(name).catch((error: unknown): SecretsCleared => (warnFor(consent, `[plugins] couldn't remove ${name}'s secrets`, error), { ok: false, remaining: [] }));
    const forgotten = updateRecord(name, () => null, consent) && (await pluginRecordsSaved(consent));
    if (!forgotten) toForget.add(name);
    await rescanPlugins(consent);
    if (!forgotten) return { ok: false, removed: true, reason: t(`Its files are removed, but plugins.json couldn't be updated; Ardia drops its record the next time it can save.`) };
    if (!secrets.ok) return { ok: false, removed: true, reason: secretsLeftReason(name, secrets) };
    return { ok: true };
  } finally {
    reopenPluginStorage(name);
    removing.delete(name);
  }
}

export function setPluginValue(name: string, key: string, value: string | boolean | number) {
  const row = currentPlugins().listings[name]?.manifest?.settings.rows.find((r) => r.key === key);
  if (!row || row.type === "secret" || rowValue(row, value) !== value) return;
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
