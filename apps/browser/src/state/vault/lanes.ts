import { learnRegistrableDomains } from "../engines/siteDataDomains";
import { knowsRegistrableDomain, registrableDomain } from "../engines/siteDataMerge";
import type { VaultTask } from "./tasks";

export type LaneHolder = { profile: string; key: string | null };

const active = new Map<string, Set<LaneHolder>>();

const hostOf = (origin: string) => new URL(origin).hostname;

export async function warmSiteKeys(origins: readonly string[]): Promise<void> {
  await learnRegistrableDomains(origins.map(hostOf));
}

export function siteKeyFor(task: VaultTask, origin: string): string | null {
  const fixed = task.siteKeys.get(origin);
  if (fixed) return fixed;
  const host = hostOf(origin);
  if (!knowsRegistrableDomain(host)) return null;
  const key = `${new URL(origin).protocol}//${registrableDomain(host)}`;
  task.siteKeys.set(origin, key);
  return key;
}

const clash = (a: string | null, b: string | null) => a === null || b === null || a === b;

export function blockers<T extends LaneHolder>(profile: string, key: string | null): T[] {
  return [...(active.get(profile) ?? [])].filter((holder) => clash(holder.key, key)) as T[];
}

export function holdLane(holder: LaneHolder) {
  if (!active.has(holder.profile)) active.set(holder.profile, new Set());
  active.get(holder.profile)!.add(holder);
}

export function releaseLane(holder: LaneHolder) {
  const held = active.get(holder.profile);
  held?.delete(holder);
  if (held && !held.size) active.delete(holder.profile);
}

export const heldLanes = (profile: string) => active.get(profile)?.size ?? 0;
