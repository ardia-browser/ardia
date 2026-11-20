import type { BrowserState } from "../browser/store";
import { capture, consentNow, consentToken, type ConsentToken } from "./client";
import { choiceLoaded, consentAtLaunch } from "./choice";
import { onTelemetryRelay } from "./relay";

type Counts = Record<string, number | boolean | string | null>;

export type TopAppsSharingPath = "synced_record" | "link_profiles" | "linked_profile_created";

const MAX_HELD = 16;
const BEFORE_LOAD = "beforeLoad";
type HeldConsent = ConsentToken | null | typeof BEFORE_LOAD;
const held: [string, Counts, HeldConsent][] = [];
const dropped = new Map<HeldConsent, number>();
const heldConsent = (): HeldConsent => (choiceLoaded() ? consentToken() : BEFORE_LOAD);
const releasedConsent = (consent: HeldConsent) => (consent === BEFORE_LOAD ? consentAtLaunch() : consent);
let released = false;
let savedMerged: string | null = null;

export function noteTopAppsSharing(event: string, counts: Counts) {
  if (released) capture(event, counts, consentNow());
  else if (held.length < MAX_HELD) held.push([event, counts, heldConsent()]);
  else dropped.set(heldConsent(), (dropped.get(heldConsent()) ?? 0) + 1);
}

export function releaseTopAppsSharing() {
  released = true;
  for (const [event, counts, consent] of held.splice(0)) capture(event, counts, releasedConsent(consent));
  for (const [consent, count] of dropped) capture("top_apps_sharing_dropped", { dropped: count }, releasedConsent(consent));
  dropped.clear();
}

onTelemetryRelay(releaseTopAppsSharing);

let syncStarted = 0;

export function startedBySync<T>(apply: () => T): T {
  syncStarted++;
  try {
    return apply();
  } finally {
    syncStarted--;
  }
}

export const sharingStartedBySync = () => syncStarted > 0;

export const noteSavedTopAppsMerged = (marker: string) => void (savedMerged = marker);

export function topAppsSharingCounts(s: Pick<BrowserState, "profiles">) {
  const profiles = Object.values(s.profiles);
  return { profile_count: profiles.length, sharing_profiles: profiles.filter((p) => p.shareTopApps).length };
}

export function topAppsSharingAtLaunch(s: Pick<BrowserState, "profiles" | "topAppsMerged">, updatedFrom: string | null) {
  const saved = savedMerged ?? s.topAppsMerged;
  const settled = s.topAppsMerged;
  return {
    ...topAppsSharingCounts(s),
    merge_recorded: saved !== "",
    merge_recorded_this_launch: settled !== "" && saved !== settled,
    merge_marker_cleared: saved !== "" && settled === "",
    from_version: updatedFrom,
  };
}

export function noteTopAppsSharingFromSync(s: Pick<BrowserState, "profiles">, path: TopAppsSharingPath, on: boolean) {
  noteTopAppsSharing("top_apps_sharing_synced", { path, on, ...topAppsSharingCounts(s) });
}
