import type { Settings } from "../settings/settings";

const MINUTE_MS = 60_000;

const DELAYS: Record<Settings["unloadProfilesAfter"], number | null> = {
  never: null,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "2h": 120 * MINUTE_MS,
};

export const profileUnloadDelay = (settings: Pick<Settings, "memorySaver" | "unloadProfilesAfter">): number | null =>
  settings.memorySaver ? (DELAYS[settings.unloadProfilesAfter] ?? null) : null;

export function idleProfiles() {
  const idleSince = new Map<string, number>();
  let shown: ReadonlySet<string> = new Set();
  const noteShown = (inUse: ReadonlySet<string>, now: number) => {
    for (const profile of shown) if (!inUse.has(profile)) idleSince.set(profile, now);
    for (const profile of inUse) idleSince.delete(profile);
    shown = inUse;
  };
  const ready = (loaded: Iterable<string>, inUse: ReadonlySet<string>, now: number, delayMs: number | null): string[] => {
    if (delayMs === null) {
      idleSince.clear();
      shown = new Set();
      return [];
    }
    noteShown(inUse, now);
    const profiles = new Set(loaded);
    for (const profile of [...idleSince.keys()]) if (!profiles.has(profile)) idleSince.delete(profile);
    const due: string[] = [];
    for (const profile of profiles) {
      if (inUse.has(profile)) continue;
      if (!idleSince.has(profile)) idleSince.set(profile, now);
      if (now - idleSince.get(profile)! >= delayMs) due.push(profile);
    }
    return due;
  };
  return Object.assign(ready, { noteShown });
}
