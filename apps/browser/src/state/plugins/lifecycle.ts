import { defaultValues, rowValue } from "../../lib/pluginManifest";
import { listPluginFolders, removePluginFiles } from "../../platform/plugins";
import { onConfigChange } from "../../platform/configFolder";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentNow, consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { programControlOn, userTurnedControlOff } from "../app/programControlSetting";
import { applySettingsPatch, planDisable, planEnable, spliceApplied } from "./defaults";
import { pluginRecordsSaved, writePluginRecords } from "./savedState";
import { settleInstall } from "./installWaiters";
import { abandonWithdrawal, activeManifest, approvalMatches, setPluginFetch, clearUnsaved, UNSAVED, commitPlugins, consentListing, currentPlugins, withdrawalsFor, type PluginsCommit, NO_RECORD, recordApproves, recordOf, usePlugins, type PluginConsentRequest, type PluginListing, type PluginRecord } from "./store";
import { activateStorePlugin, type PluginSource } from "../../platform/plugins";
import { forgetLockKey } from "./lockfile";
import { listingRevocation, revokedText } from "./revocationChecks";
import { candidatesOf, listingsOf } from "./folderListings";
import { lockAfterPromotion, officialCandidateProblem, officialProofMissing, settledPromotions, trackPromotion, undoPromotion, UNSIGNED_OFFICIAL, UNSTAGED, unstagedCandidate } from "./promotedLock";
import { pluginsScanned } from "./scanListeners";
import { stopProcess, superviseProcess, supervisedNames } from "./process";
import { checkActivations, deactivatePlugin, shouldRun } from "./activation";
import { clearPluginSurfaces } from "./surfaces";
import { clearPluginSecretsEverywhere, type SecretsCleared } from "./secrets";
import { closePluginStorage, reopenPluginStorage } from "./storage";
import { forgetPluginGestures } from "./gestures";
import { sendValues } from "./channel";
import { reconcilePrograms, removePrograms } from "./programs";
import { ownValue } from "../../lib/decode";

function saveRecords(records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  if (!writePluginRecords(records, consent)) return false;
  commitPlugins({ records });
  return true;
}

export function updateRecord(name: string, change: (r: PluginRecord) => PluginRecord | null, consent: ConsentToken | null): boolean {
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
}

const WITHDRAW_DEADLINE_MS = 1000;

function withdrawBefore(next: PluginsCommit, consent: ConsentToken | null): Promise<void> | null {
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

function applyListings(listings: PluginListing[], consent: ConsentToken | null, candidates?: PluginListing[]) {
  const byName = listingsByName(listings);
  if (candidates) usePlugins.setState({ candidates: listingsByName(candidates) });
  commitPlugins({ listings: byName, order: listings.map((l) => l.name).sort() });
  forgetRemoved(consent);
  reconcilePlugins(consent);
}

let scanning: Promise<boolean> | null = null;
let nextScan: { consent: ConsentToken | null } | null = null;

export function rescanPlugins(consent: ConsentToken | null): Promise<boolean> {
  if (scanning) {
    nextScan = { consent };
    return scanning;
  }
  scanning = (async () => {
    let scan: { consent: ConsentToken | null } | null = { consent };
    let listed = false;
    while (scan) {
      const asked = scan.consent;
      nextScan = null;
      const entries = await listPluginFolders().catch((error: unknown) => {
        warnFor(asked, "[plugins] couldn't list the plugins folder", error);
        return null;
      });
      listed = entries !== null;
      if (entries) {
        const listings = listingsOf(entries);
        const withdrawing = withdrawBefore({ listings: listingsByName(listings), records: currentPlugins().records }, asked);
        if (withdrawing) await withdrawing;
        applyListings(listings, asked, candidatesOf(entries));
        pluginsScanned(asked);
      }
      closeChangedConsent();
      if (!currentPlugins().scanned) usePlugins.setState({ scanned: true });
      scan = nextScan;
    }
    return listed;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

let lastConsentId = 0;

export const ALREADY_ASKING = "Ardia is already asking about a plugin. Answer that first, then try again.";

function closeChangedConsent() {
  const asked = currentPlugins().consent;
  if (!asked || consentListing(currentPlugins(), asked.name, asked.hash)?.hash === asked.hash) return;
  usePlugins.setState({ consent: null });
  settleInstall(asked.name, { ok: false, reason: "It changed while installing. Try again." });
}

export function consentTarget(name: string): PluginListing | undefined {
  const s = currentPlugins();
  const candidate = ownValue(s.candidates, name);
  if (candidate?.manifest && candidate.hash) return candidate;
  return ownValue(s.listings, name);
}

export type ConsentExtras = Pick<PluginConsentRequest, "bundle" | "added">;

export function requestPluginConsent(name: string, extras: ConsentExtras = {}): boolean {
  const target = consentTarget(name);
  if (currentPlugins().consent || !target?.manifest || !target.hash) return false;
  const unsigned = [{ name, listing: target }, ...(extras.bundle ?? []).map((b) => ({ name: b.name, listing: consentListing(currentPlugins(), b.name, b.hash) }))];
  if (unsigned.some((u) => !u.listing || unstagedCandidate(u.name, u.listing) || officialProofMissing(u.name, u.listing))) return false;
  usePlugins.setState({ consent: { id: ++lastConsentId, name, hash: target.hash, ...(extras.bundle?.length ? { bundle: extras.bundle } : {}), ...(extras.added?.length ? { added: extras.added } : {}) }, unsaved: null });
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

export function approvalRefusal(name: string, hash: string): string | null {
  const listing = consentListing(currentPlugins(), name, hash);
  if (!listing?.manifest || listing.hash !== hash) return "It changed while you were deciding. Try again.";
  if (unstagedCandidate(name, listing)) return `${listing.manifest.title}: ${UNSTAGED}`;
  if (officialProofMissing(name, listing)) return `${listing.manifest.title}: ${UNSIGNED_OFFICIAL}`;
  const revoked = listingRevocation(name, listing, currentPlugins().candidates[name] === listing);
  return revoked ? `${listing.manifest.title}: ${revokedText(revoked)}` : null;
}

export function enablePlugin(name: string, hash: string): boolean {
  const asked = currentPlugins().consent;
  if (asked?.name !== name || asked.hash !== hash) return false;
  const bundle = asked.bundle ?? [];
  if (!bundle.every((b) => consentListing(currentPlugins(), b.name, b.hash)?.hash === b.hash)) return false;
  const refused = [...bundle, { name, hash }].map((b) => approvalRefusal(b.name, b.hash)).find((r) => r !== null);
  if (refused) {
    usePlugins.setState({ consent: null });
    settleInstall(name, { ok: false, reason: refused });
    return false;
  }
  const consent = consentNow();
  for (const b of bundle) if (!approvePlugin(b.name, b.hash, consent)) return refuseConsent(name);
  if (!approvePlugin(name, hash, consent)) return refuseConsent(name);
  usePlugins.setState({ consent: null });
  void settledPromotions([...bundle.map((b) => b.name), name]).then((result) => settleInstall(name, result));
  return true;
}

function refuseConsent(name: string): boolean {
  usePlugins.setState({ consent: null, unsaved: name });
  settleInstall(name, { ok: false, reason: UNSAVED });
  return false;
}

export { settledPromotions };

export function approvePlugin(name: string, hash: string, consent: ConsentToken | null): boolean {
  const listing = consentListing(currentPlugins(), name, hash);
  if (!listing?.manifest || listing.hash !== hash || removing.has(name)) return false;
  if (unstagedCandidate(name, listing) || officialProofMissing(name, listing) || listingRevocation(name, listing, currentPlugins().candidates[name] === listing)) return false;
  const candidate = currentPlugins().candidates[name] === listing;
  const manifest = listing.manifest;
  const before = recordOf(currentPlugins(), name);
  const values = { ...defaultValues(manifest), ...before.values };
  const kept = before.enabled && approvalMatches(listing, before.approved);
  const records = kept || !before.enabled ? currentPlugins().records : spliceApplied(currentPlugins().records, name);
  const plan = kept ? { patch: {}, applied: before.applied } : planEnable(manifest, records, name, before.applied);
  const current = currentPlugins().listings[name];
  const previous = candidate && recordApproves(current, before) ? (approvalMatches(current, before.approved) ? before.approved : before.previous) : undefined;
  const { pendingUpdate: _pending, preapproved: _preapproved, revoked: _revoked, ...rest } = before;
  const next: PluginRecord = { ...rest, enabled: true, approved: hash, values, applied: plan.applied, ...(previous ? { previous } : {}) };
  if (!saveRecords({ ...records, [name]: next }, consent)) return false;
  if (candidate) trackPromotion(name, promoteCandidate(name, listing, consent));
  const asksControl = manifest.permissions.control;
  applySettingsPatch(kept || !asksControl || programControlOn(useBrowser.getState()) || userTurnedControlOff() ? plan.patch : { ...plan.patch, cliControl: true });
  clearUnsaved(name);
  notePlugin("plugin_enables", consent);
  reconcilePlugins(consent);
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
  setPluginFetch(name, { state: "promoting" });
  const exact = adoptExactApproval(name, candidate, consent);
  const saved = exact && (await pluginRecordsSaved(consent));
  const record = recordOf(currentPlugins(), name);
  if (!saved || !record.enabled || !approvalMatches(candidate, record.approved)) {
    setPluginFetch(name, { state: "failed", code: "failed", reason: saved ? "Its approval changed before it could be switched to." : UNSAVED });
    return false;
  }
  const unsigned = await officialCandidateProblem(name, candidate);
  const before = ownValue(currentPlugins().listings, name);
  let promoted = unsigned ? { ok: false as const, reason: unsigned } : await activateStorePlugin(name, candidate.folderId, candidate.hash!).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (promoted.ok && !(await lockAfterPromotion(name, candidate, consent))) promoted = { ok: false, reason: await undoPromotion(name, before, (n, edit) => updateRecord(n, edit, consent)) };
  if (!promoted.ok) warnFor(consent, `[plugins] ${name}'s download couldn't be switched to: ${promoted.reason}`);
  await rescanPlugins(consent);
  setPluginFetch(name, promoted.ok ? null : { state: "failed", code: "failed", reason: promoted.reason });
  if (!promoted.ok) setTimeout(() => void rescanPlugins(consent), PROMOTION_RETRY.delayMs);
  return promoted.ok;
}

export function turnOnApprovedPlugin(name: string): boolean {
  const s = currentPlugins();
  const listing = ownValue(s.listings, name);
  const before = recordOf(s, name);
  if (!listing?.manifest || before.enabled || !recordApproves(listing, before) || removing.has(name) || s.consent) return false;
  if (listingRevocation(name, listing)) return false;
  const consent = consentNow();
  const plan = planEnable(listing.manifest, s.records, name, before.applied);
  if (!saveRecords({ ...s.records, [name]: { ...before, enabled: true, applied: plan.applied } }, consent)) return false;
  clearUnsaved(name);
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
export const isRemoving = (name: string) => removing.has(name);

const secretsLeftReason = (name: string, secrets: SecretsCleared) =>
  `Its files are removed, but ${secrets.remaining.length === 1 ? "1 secret is" : secrets.remaining.length ? `${secrets.remaining.length} secrets are` : "its secrets may be"} still in your Keychain, under ardia.plugin.${name}. Delete them in Keychain Access.`;

type RemovalIdentity = { source: PluginSource; folderId: string | null };

export function removalIdentity(name: string): RemovalIdentity {
  const listed = ownValue(currentPlugins().listings, name);
  const source = listed?.source ?? (Object.hasOwn(currentPlugins().candidates, name) ? "store" : "local");
  return { source, folderId: listed?.folderId || null };
}

export async function removePlugin(name: string, mayGoOn: () => boolean = () => true, expected?: RemovalIdentity): Promise<{ ok: boolean; removed?: boolean; reason?: string }> {
  if (removing.has(name)) return { ok: false, reason: "It is already being removed." };
  const identity = removalIdentity(name);
  const source = identity.source;
  if (expected && (expected.source !== identity.source || expected.folderId !== identity.folderId)) return { ok: false, reason: "It changed while you were deciding. Try again." };
  const consent = consentToken();
  removing.add(name);
  try {
    if (!(await turnOffPlugin(name, consent))) return { ok: false, reason: "It couldn't be turned off, because Ardia couldn't save its plugin settings." };
    if (!(await pluginRecordsSaved(consent))) return { ok: false, reason: "It couldn't be turned off, because Ardia couldn't save its plugin settings." };
    if (!mayGoOn()) return { ok: false, reason: "Control was turned off after Ardia turned it off, so its files are still there." };
    await removePrograms(name, consent);
    if (!mayGoOn()) return { ok: false, reason: "Control was turned off after Ardia unlinked its programs, so its files are still there." };
    await closePluginStorage(name);
    const now = removalIdentity(name);
    if (expected && (now.source !== source || (source === "local" && expected.folderId !== null && now.folderId !== null && now.folderId !== expected.folderId)))
      return { ok: false, reason: "It changed while it was being removed, so its files are still there. Try again." };
    const removed = await removePluginFiles(name, source, source === "local" ? (expected?.folderId ?? identity.folderId) : null).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (!removed.ok) return removed;
    const secrets = source === "dev" ? { ok: true, remaining: [] } : await clearPluginSecretsEverywhere(name, Object.keys(useBrowser.getState().profiles)).catch((error: unknown): SecretsCleared => (warnFor(consent, `[plugins] couldn't remove ${name}'s secrets`, error), { ok: false, remaining: [] }));
    const unlocked = source === "dev" || (await forgetLockKey(name, consent));
    const forgotten = updateRecord(name, () => null, consent) && (await pluginRecordsSaved(consent)) && unlocked;
    if (!forgotten) toForget.add(name);
    await rescanPlugins(consent);
    if (!forgotten) return { ok: false, removed: true, reason: "Its files are removed, but Ardia couldn't save its plugin settings; it drops its record the next time it can save." };
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
