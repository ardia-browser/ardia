type SavedCohort = { lastLaunchAt: number | null; versionSince: number | null; versionColdLaunches: number | null };
type LaunchCohort = { versionSince: number | null; versionColdLaunches: number | null; coldNth: number | null };

export function nextLaunchCohort(saved: SavedCohort, firstOfVersion: boolean, startedAt: number, bootTime: number | null | undefined): LaunchCohort {
  const cold = bootTime != null && saved.lastLaunchAt != null ? saved.lastLaunchAt < bootTime : null;
  if (firstOfVersion) return { versionSince: startedAt, versionColdLaunches: cold ? 1 : 0, coldNth: cold ? 1 : null };
  const before = saved.versionColdLaunches;
  const count = before === null ? null : before + (cold ? 1 : 0);
  return { versionSince: saved.versionSince, versionColdLaunches: count, coldNth: cold && count !== null ? count : null };
}

const DAY = 86_400_000;

export const coldNthBucket = (nth: number | null) => (nth === null || nth < 1 ? null : nth >= 3 ? "3+" : String(nth));

export function versionAgeBucket(versionSince: number | null, at: number) {
  if (versionSince === null || at < versionSince) return null;
  const age = at - versionSince;
  return age < DAY ? "<1d" : age < 2 * DAY ? "<2d" : age < 4 * DAY ? "<4d" : age < 7 * DAY ? "<7d" : "7d+";
}

export const launchCohortFields = (previous: { coldNth?: number | null; versionSince?: number | null }, at: number) => ({
  cold_nth: coldNthBucket(previous.coldNth ?? null),
  version_age: versionAgeBucket(previous.versionSince ?? null, at),
});
