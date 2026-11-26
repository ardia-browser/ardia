import { isNativeTier, verifyOfficialArtifact, type PlatformKey } from "@ardia/plugin-sdk/registry";
import { removePluginFiles, rollbackStorePlugin } from "../../platform/plugins";
import { pluginSubtle } from "../../platform/pluginCrypto";
import { isOfficialId } from "../../lib/pluginIds";
import { commitStagedLock, lockEntryByKey, provenance, stagedLockEntry, type LockEntry, type LockProvenance } from "./lockfile";
import { officialNativeKeys } from "./registryKeys";
import { shaOfFolderId } from "./revocationChecks";
import { currentPlugins, type PluginListing, type PluginRecord } from "./store";
import type { ConsentToken } from "../telemetry/choice";

const promotions = new Map<string, Promise<boolean>>();

export function trackPromotion(name: string, running: Promise<boolean>) {
  promotions.set(name, running);
  void running.finally(() => {
    if (promotions.get(name) === running) promotions.delete(name);
  });
}

export async function settledPromotions(names: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const name of names) {
    const running = promotions.get(name);
    if (!running || (await running)) continue;
    const fetch = currentPlugins().fetches[name];
    return { ok: false, reason: fetch?.state === "failed" ? fetch.reason : "It couldn't be switched to the new copy. Try again." };
  }
  return { ok: true };
}

export function promotedLockEntry(name: string, candidate: PluginListing): LockEntry | null {
  const manifest = candidate.manifest;
  if (!manifest) return null;
  const was = lockEntryByKey(name);
  const staged = stagedLockEntry(name, candidate.folderId);
  const sha256 = shaOfFolderId(candidate.folderId);
  const derived: LockEntry | null = was
    ? (() => {
        const { officialSig: _sig, platform: _platform, ...rest } = was;
        return { ...rest, version: manifest.version, sha256, payloadDigest: null, dependencies: Object.keys(manifest.v3?.dependencies ?? {}).sort() };
      })()
    : null;
  const base = staged ?? derived;
  if (!base) return null;
  const { pending: _pending, previous: _previous, ...rest } = base;
  const replaced = was && was.version && (was.version !== base.version || was.sha256 !== base.sha256);
  const earlier = replaced ? provenance(was) : was?.previous;
  return { ...rest, installedAt: Date.now(), ...(earlier ? { previous: earlier } : {}) };
}

export async function lockAfterPromotion(name: string, candidate: PluginListing, consent: ConsentToken | null): Promise<boolean> {
  const next = promotedLockEntry(name, candidate);
  if (!next) return true;
  return commitStagedLock(name, next, consent);
}

export function candidateProvenance(name: string, candidate: Pick<PluginListing, "folderId">): LockProvenance | null {
  const sha256 = shaOfFolderId(candidate.folderId);
  const staged = stagedLockEntry(name, candidate.folderId);
  if (staged) return staged;
  const entry = lockEntryByKey(name);
  if (entry && sha256 && entry.sha256 === sha256) return entry;
  return entry?.previous && sha256 && entry.previous.sha256 === sha256 ? entry.previous : null;
}

const needsOfficialProof = (candidate: Pick<PluginListing, "manifest" | "source">) =>
  candidate.source === "store" && !!candidate.manifest && isOfficialId(candidate.manifest.id) && !!candidate.manifest.v3 && isNativeTier(candidate.manifest.v3);

export const unstagedCandidate = (name: string, listing: Pick<PluginListing, "source" | "folderId">): boolean =>
  currentPlugins().candidates[name]?.folderId === listing.folderId && listing.source === "store" && !stagedLockEntry(name, listing.folderId);

export const UNSTAGED = "Ardia hasn't saved where this download came from yet, so it can't be approved. Try again.";

export const UNSIGNED_OFFICIAL = "It reaches outside Ardia's sandbox but isn't signed by Ardia's release key, so Ardia won't turn it on.";

export function officialProofMissing(name: string, candidate: Pick<PluginListing, "manifest" | "source" | "folderId">): boolean {
  if (!needsOfficialProof(candidate)) return false;
  const known = candidateProvenance(name, candidate);
  return !known?.officialSig || !known.platform;
}

export async function officialCandidateProblem(name: string, candidate: Pick<PluginListing, "manifest" | "source" | "folderId">): Promise<string | null> {
  if (!needsOfficialProof(candidate)) return null;
  const known = candidateProvenance(name, candidate);
  const sha256 = shaOfFolderId(candidate.folderId);
  if (!known?.officialSig || !known.platform || !sha256) return UNSIGNED_OFFICIAL;
  const claim = { id: candidate.manifest!.id, version: candidate.manifest!.version, platform: known.platform as PlatformKey, sha256 };
  const verified = await verifyOfficialArtifact(claim, known.officialSig, officialNativeKeys(), { subtle: pluginSubtle() });
  return verified.ok ? null : UNSIGNED_OFFICIAL;
}

export async function undoPromotion(name: string, before: PluginListing | undefined, change: (name: string, edit: (r: PluginRecord) => PluginRecord | null) => boolean): Promise<string> {
  const sha256 = shaOfFolderId(before?.folderId);
  if (before?.source === "store" && before.manifest && sha256) {
    const back = await rollbackStorePlugin(name, before.manifest.version, sha256).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
    if (back.ok) change(name, (r) => ({ ...r, approved: r.previous ?? r.approved, previous: undefined }));
    return back.ok ? `Ardia couldn't save plugins-lock.json, so it stayed on ${before.manifest.version}. Try again.` : `Ardia couldn't save plugins-lock.json or go back to ${before.manifest.version}: ${back.reason}`;
  }
  const removed = await removePluginFiles(name, "store", null).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (removed.ok) change(name, () => null);
  return removed.ok ? "Ardia couldn't save plugins-lock.json, so it wasn't installed. Try again." : `Ardia couldn't save plugins-lock.json or take the download back: ${removed.reason}`;
}
