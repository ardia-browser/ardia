import type { RevocationMatch } from "@ardia/plugin-sdk/registry";
import { lockEntryByKey, stagedLockEntry } from "./lockfile";
import { revocationReason, stoppingRevocation, type RevocationSubject } from "./revocations";
import type { PluginListing } from "./store";

export const shaOfFolderId = (folderId: string | undefined | null): string | null => (folderId && /^store-[0-9a-f]{64}$/.test(folderId) ? folderId.slice(6) : null);

export function subjectOf(name: string, listing: Pick<PluginListing, "manifest" | "folderId">): RevocationSubject | null {
  const manifest = listing.manifest;
  if (!manifest) return null;
  const entry = lockEntryByKey(name);
  const staged = stagedLockEntry(name, listing.folderId);
  const exact = staged ?? (entry && entry.version === manifest.version ? entry : undefined);
  const sha256 = shaOfFolderId(listing.folderId) ?? exact?.sha256 ?? null;
  const source = exact?.source ?? entry?.source;
  const repo = exact?.repo ?? entry?.repo;
  return { id: manifest.id, version: manifest.version, sha256, ...(source ? { source } : {}), ...(repo ? { repo } : {}) };
}

export function listingRevocation(name: string, listing: Pick<PluginListing, "manifest" | "folderId">, includeYank = false): RevocationMatch | null {
  const subject = subjectOf(name, listing);
  return subject ? stoppingRevocation(subject, includeYank) : null;
}

export const revokedText = (match: RevocationMatch) => `Ardia's registry turned it off: ${revocationReason(match)}`;
