import type { ImportedExtension, ImportedExtensionSkip } from "../../platform/importModule";

export type ExtensionGroup = { sourceProfile: string; profileId: string; list: ImportedExtension[] };

type ListedExtension = { id: string; name: string; webStoreUrl: string; offInSource: boolean; pinnedInSource: boolean };

export type ExtensionTarget = { profileId: string; profileName: string; extensions: ListedExtension[] };

type LeftOutReason = ImportedExtensionSkip | "installed";
type LeftOutExtension = { name: string; reason: LeftOutReason };

export type ExtensionListing = { targets: ExtensionTarget[]; leftOut: LeftOutExtension[]; storeOpened: boolean };

const LEFT_OUT_REASONS: readonly LeftOutReason[] = ["installed", "manifestV2", "unpacked", "policy", "external", "notWebStore"];

const WEB_STORE_DETAIL = "https://chromewebstore.google.com/detail/";
const EXTENSION_ID = /^[a-p]{32}$/;

const readsInstallSource = (e: ImportedExtension) => typeof e.enabled === "boolean";

const listed = (e: ImportedExtension): ListedExtension => ({
  id: e.id,
  name: e.name,
  webStoreUrl: `${WEB_STORE_DETAIL}${e.id}`,
  offInSource: e.enabled === false,
  pinnedInSource: typeof e.pinnedIndex === "number",
});

const byName = (a: ListedExtension, b: ListedExtension) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function planExtensionListing(
  groups: ExtensionGroup[],
  installedIn: (profileId: string) => ReadonlySet<string>,
  profileName: (profileId: string) => string,
): ExtensionListing | null {
  if (!groups.every((g) => g.list.every(readsInstallSource))) return null;
  const targets = new Map<string, ExtensionTarget>();
  const leftOut = new Map<string, LeftOutExtension>();
  const leave = (name: string, reason: LeftOutReason) => leftOut.set(`${reason}\n${name}`, { name, reason });
  for (const group of groups) {
    if (!group.profileId) continue;
    const installed = installedIn(group.profileId);
    const target = targets.get(group.profileId) ?? { profileId: group.profileId, profileName: profileName(group.profileId), extensions: [] };
    for (const e of group.list) {
      if (e.skip) leave(e.name, e.skip);
      else if (!EXTENSION_ID.test(e.id)) leave(e.name, "notWebStore");
      else if (installed.has(e.id)) leave(e.name, "installed");
      else if (!target.extensions.some((x) => x.id === e.id)) target.extensions.push(listed(e));
    }
    targets.set(group.profileId, target);
  }
  const shown = [...targets.values()].filter((t) => t.extensions.length).map((t) => ({ ...t, extensions: [...t.extensions].sort(byName) }));
  if (!shown.length && !leftOut.size) return null;
  return { targets: shown, leftOut: [...leftOut.values()], storeOpened: false };
}

export const listedCount = (listing: ExtensionListing) => listing.targets.reduce((n, t) => n + t.extensions.length, 0);

export function leftOutCounts(listing: ExtensionListing): Record<LeftOutReason, number> {
  const counts = Object.fromEntries(LEFT_OUT_REASONS.map((r) => [r, 0])) as Record<LeftOutReason, number>;
  for (const e of listing.leftOut) counts[e.reason] += 1;
  return counts;
}

const LEFT_OUT_WORDS: Record<LeftOutReason, string> = {
  installed: "already in Ardia",
  manifestV2: "uses Manifest V2, which Chrome no longer runs",
  unpacked: "loaded unpacked in developer mode",
  policy: "installed by your organization's policy",
  external: "added by another app",
  notWebStore: "not from the Chrome Web Store",
};

export const leftOutText = (e: LeftOutExtension) => `${e.name} (${LEFT_OUT_WORDS[e.reason]})`;

export function sourceNotes(e: ListedExtension, sourceName: string): string {
  const notes = [e.offInSource ? "off" : "", e.pinnedInSource ? "pinned" : ""].filter(Boolean);
  return notes.length ? `${notes.join(" and ")} in ${sourceName}` : "";
}
