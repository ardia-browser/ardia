import type { Download } from "../../platform/downloads";
import type { FolderListing } from "./folderMedia";
import { derivedOf, downloadItems, mediaItems, mediaOfKind, type DownloadItem, type MediaItem, type Ownership } from "./items";
import type { MediaKind } from "./library";
import { downloadOwners, ownersOfEngines, withinProfile, type ProfileOwners } from "./profileScope";

const ownedDownloads = new WeakMap<readonly Download[], { owners: ProfileOwners; list: Download[] }>();

export function downloadsOwnedIn(all: readonly Download[], owners: ProfileOwners): Download[] {
  const kept = ownedDownloads.get(all);
  if (kept?.owners === owners) return kept.list;
  const list = all.filter((d) => !!downloadOwners(owners, d)?.length);
  ownedDownloads.set(all, { owners, list });
  return list;
}

const ownerships = new WeakMap<ProfileOwners, WeakMap<readonly FolderListing[], Ownership>>();

export function fileOwnership(owners: ProfileOwners, listings: readonly FolderListing[]): Ownership {
  let byListings = ownerships.get(owners);
  if (!byListings) ownerships.set(owners, (byListings = new WeakMap()));
  let ownership = byListings.get(listings);
  if (ownership) return ownership;
  const byPath = new Map<string, readonly string[]>();
  for (const listing of listings) {
    const listed = ownersOfEngines(owners, listing.engines);
    for (const file of listing.files) byPath.set(file.path, listed);
  }
  ownership = { download: (d) => downloadOwners(owners, d), file: (file) => byPath.get(file.path) };
  byListings.set(listings, ownership);
  return ownership;
}

const allMedia = new WeakMap<readonly Download[], WeakMap<readonly FolderListing[], { owners: ProfileOwners | null; items: MediaItem[] }>>();

function allMediaOf(downloads: readonly Download[], listings: readonly FolderListing[], owners: ProfileOwners | null): MediaItem[] {
  let byListings = allMedia.get(downloads);
  if (!byListings) allMedia.set(downloads, (byListings = new WeakMap()));
  const kept = byListings.get(listings);
  if (kept && kept.owners === owners) return kept.items;
  const files = listings.length === 1 ? listings[0]!.files : listings.flatMap((l) => l.files);
  const items = mediaItems(downloads, "all", files, owners ? fileOwnership(owners, listings) : undefined);
  byListings.set(listings, { owners, items });
  return items;
}

const allDownloadItems = new WeakMap<readonly Download[], { owners: ProfileOwners | null; items: DownloadItem[] }>();

function downloadItemsOf(downloads: readonly Download[], owners: ProfileOwners | null): DownloadItem[] {
  const kept = allDownloadItems.get(downloads);
  if (kept && kept.owners === owners) return kept.items;
  const items = owners ? downloadItems(downloads, (d) => downloadOwners(owners, d)) : downloadItems(downloads);
  allDownloadItems.set(downloads, { owners, items });
  return items;
}

export function libraryMediaOf(downloads: readonly Download[], listings: readonly FolderListing[], kind: MediaKind, owners: ProfileOwners | null, profile: string | null): readonly MediaItem[] {
  const base = allMediaOf(downloads, listings, owners);
  return derivedOf(base, `${kind}\n${profile ?? ""}`, () => withinProfile(mediaOfKind(base, kind), profile));
}

export function libraryDownloadsOf(downloads: readonly Download[], owners: ProfileOwners | null, profile: string | null): readonly DownloadItem[] {
  const base = downloadItemsOf(downloads, owners);
  return profile === null ? base : derivedOf(base, profile, () => withinProfile(base, profile));
}

