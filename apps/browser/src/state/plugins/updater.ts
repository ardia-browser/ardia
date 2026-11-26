import { diffSecuritySurface, verifyOfficialArtifact, type PlatformKey } from "@ardia/plugin-sdk/registry";
import { compareVersions } from "@ardia/plugin-sdk/semver";
import { rollbackStorePlugin } from "../../platform/plugins";
import { pluginSubtle } from "../../platform/pluginCrypto";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { idOfKey, isOfficialId } from "../../lib/pluginIds";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { notePlugin } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { dropCandidate, wantCandidate } from "./candidates";
import { prepareInstall, recordUnchangedInLock, type Downloaded } from "./installer";
import { approvePlugin, reconcilePlugins, requestPluginConsent, rescanPlugins, settledPromotions, updateRecord } from "./lifecycle";
import { currentLock, lockEntryByKey, provenance, updateLock, withProvenance, type LockEntry, type LockProvenance } from "./lockfile";
import { fetchIndex, registryForUrl } from "./registryClient";
import { officialNativeKeys } from "./registryKeys";
import { currentRevocations, refreshRevocations, revocationReason, revocationsFor, stoppingRevocation } from "./revocations";
import { listingRevocation, shaOfFolderId, subjectOf } from "./revocationChecks";
import { MAX_UPDATE_LINES } from "./savedState";
import { afterPluginScan } from "./scanListeners";
import { currentPlugins, recordOf, type PendingUpdate, type PluginListing } from "./store";
import { migrateLegacyPlugins } from "./migration";

export const CHECK_EVERY_MS = 20 * 60 * 1000;

const incompatible = (listing: PluginListing | undefined) => !!listing?.problems.some((p) => p.startsWith("Incompatible with Ardia"));

async function newestTag(entry: LockEntry): Promise<string | null> {
  if (entry.source.kind !== "registry") return null;
  const ref = registryForUrl(entry.source.url);
  if (!ref) return null;
  const index = await fetchIndex(ref);
  if (!index.ok) return null;
  const listed = index.value.plugins.find((p) => p.id === entry.id);
  const tag = listed ? (entry.channel === "beta" ? (listed.tags.beta ?? listed.tags.latest) : listed.tags.latest) : undefined;
  return tag ?? null;
}

export function updateVerdict(installed: PluginListing | undefined, candidate: PluginListing): { silent: boolean; added: string[] } {
  const before = installed?.manifest?.v3;
  const after = candidate.manifest?.v3;
  if (!before || !after) return { silent: false, added: ["a plugin Ardia couldn't compare with the one you approved"] };
  const diff = diffSecuritySurface(before, after);
  return { silent: !diff.expanded, added: diff.added.slice(0, MAX_UPDATE_LINES) };
}

type BundledUpdate = { downloaded: Downloaded; candidate: PluginListing; silent: boolean; added: string[] };

export function bundleVerdicts(downloaded: readonly Downloaded[], rootId: string): BundledUpdate[] | null {
  const s = currentPlugins();
  const out: BundledUpdate[] = [];
  for (const d of downloaded) {
    if (d.plugin.id === rootId) continue;
    const candidate = s.candidates[d.plugin.key];
    if (!candidate?.hash || candidate.folderId !== d.folderId) return null;
    const installed = s.listings[d.plugin.key];
    const known = !!installed?.manifest && recordOf(s, d.plugin.key).enabled;
    const verdict = known ? updateVerdict(installed, candidate) : { silent: false, added: [`${d.plugin.id}, a plugin it now needs`] };
    out.push({ downloaded: d, candidate, ...verdict });
  }
  return out;
}

async function updateOne(entry: LockEntry, consent: ConsentToken | null): Promise<"none" | "silent" | "prompted" | "failed"> {
  const s = currentPlugins();
  const listing = s.listings[entry.key];
  const record = recordOf(s, entry.key);
  if (!record.enabled && !record.preapproved) return "none";
  const tag = await newestTag(entry);
  const due = entry.pending === "migration" || !entry.version || incompatible(listing) || (tag && compareVersions(tag, entry.version) > 0);
  if (!due) return "none";
  const request = { id: entry.id, channel: entry.channel, source: entry.source };
  const prepared = await prepareInstall(request, consent, true);
  if (!prepared.ok) return "failed";
  const mine = prepared.downloaded.find((d) => d.plugin.id === entry.id);
  const candidate = currentPlugins().candidates[entry.key];
  if (!mine || !candidate?.hash || candidate.folderId !== mine.folderId) return "none";
  const bundle = bundleVerdicts(prepared.downloaded, entry.id);
  if (!bundle) return "failed";
  const trusted = entry.pending === "migration" || record.preapproved;
  const verdict = trusted ? { silent: true, added: [] } : updateVerdict(listing, candidate);
  if (verdict.silent && bundle.every((b) => b.silent || trusted)) {
    const order = [...bundle.map((b) => ({ name: b.downloaded.plugin.key, hash: b.candidate.hash! })), { name: entry.key, hash: candidate.hash }];
    if (!order.every((w) => approvePlugin(w.name, w.hash, consent))) return "failed";
    const promoted = await settledPromotions(order.map((w) => w.name));
    if (!promoted.ok) return "failed";
    recordUnchangedInLock(prepared.plan, prepared.downloaded, request, consent);
    const note = { from: listing?.manifest?.version ?? entry.version, to: mine.plugin.version, added: [] };
    updateRecord(entry.key, (r) => ({ ...r, updated: note }), consent);
    notePlugin(entry.pending === "migration" ? "migrations_adopted" : "updates_silent", consent);
    return "silent";
  }
  const added = [...verdict.added, ...bundle.flatMap((b) => b.added.map((line) => (line.startsWith(b.downloaded.plugin.id) ? line : `${b.downloaded.plugin.id}: ${line}`)))].slice(0, MAX_UPDATE_LINES);
  const pending: PendingUpdate = {
    version: mine.plugin.version,
    folderId: mine.folderId,
    added,
    dependencies: bundle.map((b) => b.downloaded.plugin.id),
    ...(bundle.length ? { bundle: bundle.map((b) => ({ name: b.downloaded.plugin.key, folderId: b.downloaded.folderId })) } : {}),
  };
  updateRecord(entry.key, (r) => ({ ...r, pendingUpdate: pending }), consent);
  notePlugin("updates_prompted", consent);
  return "prompted";
}

export function reviewUpdate(key: string): boolean {
  const record = recordOf(currentPlugins(), key);
  const pending = record.pendingUpdate;
  if (!pending) return false;
  wantCandidate(key, pending.folderId);
  for (const b of pending.bundle ?? []) wantCandidate(b.name, b.folderId);
  const s = currentPlugins();
  const missing = [{ name: key, folderId: pending.folderId }, ...(pending.bundle ?? [])].some((b) => s.candidates[b.name]?.folderId !== b.folderId || !s.candidates[b.name]?.hash);
  if (missing) {
    void rescanPlugins(consentToken());
    return false;
  }
  const bundle = (pending.bundle ?? []).map((b) => ({ name: b.name, hash: s.candidates[b.name]!.hash! }));
  return requestPluginConsent(key, { added: pending.added, bundle });
}

async function officialRollbackProblem(id: string, target: LockProvenance | undefined, version: string, sha256: string | null, native: boolean): Promise<string | null> {
  if (!isOfficialId(id) || !native) return null;
  if (!target?.officialSig || !target.platform || !sha256) return `${id} ${version} has no record of Ardia's release signature, so Ardia won't go back to it`;
  const verified = await verifyOfficialArtifact({ id, version, platform: target.platform as PlatformKey, sha256 }, target.officialSig, officialNativeKeys(), { subtle: pluginSubtle() });
  return verified.ok ? null : `${id} ${version} isn't signed by Ardia's release key: ${verified.reason}`;
}

export async function rollbackPlugin(key: string): Promise<{ ok: boolean; reason?: string }> {
  const consent = consentToken();
  const record = recordOf(currentPlugins(), key);
  const listing = currentPlugins().listings[key];
  if (listing?.source !== "store" || !record.previous || !listing.previousVersion || !listing.previousFolderId) return { ok: false, reason: "There's no earlier version to go back to." };
  const entry = lockEntryByKey(key);
  const id = listing.manifest?.id ?? entry?.id ?? idOfKey(key);
  if (!id) return { ok: false, reason: "There's no earlier version to go back to." };
  const sha256 = shaOfFolderId(listing.previousFolderId);
  const target = entry?.previous && entry.previous.version === listing.previousVersion && entry.previous.sha256 === sha256 ? entry.previous : undefined;
  const revoked = stoppingRevocation({ id, version: listing.previousVersion, sha256, ...(target ? { source: target.source, ...(target.repo ? { repo: target.repo } : {}) } : entry ? { source: entry.source } : {}) }, true);
  const unsigned = revoked ? null : await officialRollbackProblem(id, target, listing.previousVersion, sha256, listing.previousNative !== false);
  if (revoked || unsigned) {
    notePlugin("rollback_refusals", consent);
    return { ok: false, reason: revoked ? `${listing.previousVersion} was turned off by Ardia's registry: ${revocationReason(revoked)}` : unsigned! };
  }
  if (!sha256) return { ok: false, reason: "There's no earlier version to go back to." };
  const switched = await rollbackStorePlugin(key, listing.previousVersion, sha256).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!switched.ok) return switched;
  if (entry) {
    const restored: LockProvenance = target ?? { version: listing.previousVersion, source: entry.source, sha256, payloadDigest: null, dependencies: [] };
    const written = await updateLock((now) => (now[entry.id] ? { ...now, [entry.id]: { ...withProvenance(now[entry.id]!, restored), previous: provenance(now[entry.id]!) } } : now), consent);
    const currentSha = shaOfFolderId(listing.folderId);
    if (!written && listing.manifest && currentSha) {
      const back = await rollbackStorePlugin(key, listing.manifest.version, currentSha).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
      const rescanned = await rescanPlugins(consent);
      if (back.ok) return { ok: false, reason: `Ardia couldn't save plugins-lock.json, so it stayed on ${listing.manifest.version}. Try again.` };
      const running = (rescanned ? currentPlugins().listings[key]?.manifest?.version : undefined) ?? listing.previousVersion;
      if (running === listing.previousVersion) updateRecord(key, (r) => ({ ...r, approved: r.previous ?? r.approved, previous: r.approved ?? undefined }), consent);
      notePlugin("rollback_refusals", consent);
      return { ok: false, reason: `Ardia went back to ${running}, but couldn't save plugins-lock.json or switch forward again (${back.reason}); the lock still lists ${listing.manifest.version} until it's saved.` };
    }
  }
  const note = { from: listing.manifest?.version ?? null, to: listing.previousVersion, added: [], rolledBack: true as const };
  updateRecord(key, (r) => ({ ...r, approved: r.previous ?? r.approved, previous: r.approved ?? undefined, updated: note }), consent);
  await rescanPlugins(consent);
  notePlugin("updates_rolled_back", consent);
  return { ok: true };
}

export async function enforceRevocations(consent: ConsentToken | null) {
  if (!currentRevocations()) return;
  const s = currentPlugins();
  for (const name of Object.keys(s.listings)) {
    const listing = s.listings[name]!;
    const subject = subjectOf(name, listing);
    if (!subject) continue;
    const record = recordOf(currentPlugins(), name);
    const match = listingRevocation(name, listing);
    if (!match) {
      if (record.revoked) updateRecord(name, ({ revoked: _revoked, ...rest }) => rest, consent);
      continue;
    }
    const rollbackTo = match.rollbackTo;
    if (match.action === "disable" && rollbackTo && listing.previousVersion === rollbackTo && !record.revoked) {
      const back = await rollbackPlugin(name);
      if (back.ok) {
        notePlugin("revocations_rolled_back", consent);
        continue;
      }
    }
    if (record.revoked?.version === subject.version) continue;
    const action = match.action === "block" ? "block" : "disable";
    updateRecord(name, (r) => ({ ...r, revoked: { action, reason: revocationReason(match), ...(subject.version ? { version: subject.version } : {}) } }), consent);
    notePlugin(action === "block" ? "revocations_block" : "revocations_disable", consent);
  }
  reconcilePlugins(consent);
}

let running: Promise<void> | null = null;

export function checkPlugins(consent: ConsentToken | null): Promise<void> {
  if (!PLATFORM_FEATURES.plugins) return Promise.resolve();
  running ??= (async () => {
    await migrateLegacyPlugins(consent);
    const revoked = await refreshRevocations();
    if (!revoked.ok) warnFor(consent, `[plugins] revocations weren't refreshed: ${revoked.reason ?? "unknown"}`);
    await enforceRevocations(consent);
    for (const entry of Object.values(currentLock())) {
      if (revocationsFor(entry).some((m) => m.action === "block")) continue;
      const outcome = await updateOne(entry, consent).catch(() => "failed" as const);
      if (outcome === "failed") notePlugin("updates_failed", consent);
      if (outcome !== "silent") dropCandidate(entry.key);
    }
    await migrateLegacyPlugins(consent);
    await rescanPlugins(consent);
  })().finally(() => {
    running = null;
  });
  return running;
}

let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function watchPluginUpdates() {
  if (watching) return;
  watching = true;
  let first = true;
  afterPluginScan(() => {
    if (!first) return;
    first = false;
    void checkPlugins(consentToken());
  });
  timer = setInterval(() => void checkPlugins(consentToken()), CHECK_EVERY_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function stopPluginUpdatesForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  watching = false;
}
