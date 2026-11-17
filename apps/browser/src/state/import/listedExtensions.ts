import { listExtensions } from "../../platform/extensions";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { noteImportExtensionListing, noteImportExtensionStorePages } from "../telemetry/importRuns";
import { openInWebStore } from "./apply";
import { leftOutCounts, listedCount, planExtensionListing, type ExtensionGroup, type ExtensionListing } from "./extensionListing";
import { importNow, patchImport } from "./flow";

const INSTALLED_CHECK_MS = 5_000;

function installedIds(profileId: string): Promise<ReadonlySet<string>> {
  const none: ReadonlySet<string> = new Set();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ReadonlySet<string>>((resolve) => (timer = setTimeout(() => resolve(none), INSTALLED_CHECK_MS)));
  const read = listExtensions(engineProfile(useBrowser.getState(), profileId)).then(
    (list) => new Set(list.map((e) => e.id)),
    () => none,
  );
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export async function listFoundExtensions(groups: ExtensionGroup[]): Promise<ExtensionListing | null> {
  if (!groups.some((g) => g.list.length)) return null;
  const wanted = [...new Set(groups.filter((g) => g.profileId && g.list.some((e) => !e.skip)).map((g) => g.profileId))];
  const installed = new Map(await Promise.all(wanted.map(async (profileId) => [profileId, await installedIds(profileId)] as const)));
  const listing = planExtensionListing(
    groups,
    (profileId) => installed.get(profileId) ?? new Set(),
    (profileId) => useBrowser.getState().profiles[profileId]?.name ?? "",
  );
  if (listing) noteImportExtensionListing(listedCount(listing), leftOutCounts(listing));
  return listing;
}

function markStoreOpened() {
  const { step } = importNow();
  if (step.name !== "done" || !step.extensions.listing) return;
  patchImport({ step: { ...step, extensions: { ...step.extensions, listing: { ...step.extensions.listing, storeOpened: true } } } });
}

export function openExtensionStorePage(profileId: string, url: string) {
  openInWebStore(profileId, [url]);
  noteImportExtensionStorePages(1);
}

export function openListedExtensionsInStore() {
  const { step } = importNow();
  const listing = step.name === "done" ? step.extensions.listing : null;
  if (!listing) return;
  for (const t of listing.targets) openInWebStore(t.profileId, t.extensions.map((e) => e.webStoreUrl));
  noteImportExtensionStorePages(listedCount(listing));
  markStoreOpened();
}
