export type AndroidReleaseChannel = "stable" | "nightly";

export type AndroidRelease = { text: string; major: number; minor: number; patch: number; nightly: number | null; code: number; channel: AndroidReleaseChannel };

export const STABLE_SLOT = 999;
export const LAB_VERSION_CODE = 2;
export const MAX_VERSION_CODE = 2_100_000_000;

const NUMBER = "(0|[1-9]\\d{0,8})";
const RELEASE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-nightly\\.${NUMBER})?$`);

export function androidReleaseProblem(text: unknown): string | null {
  if (typeof text !== "string") return "a release version is text";
  const match = RELEASE.exec(text);
  if (!match) return `${text} is neither a stable (<major>.<minor>.<patch>) nor a nightly (<next stable>-nightly.<n>) version`;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const nightly = match[4] === undefined ? null : Number(match[4]);
  if (major > 20 || minor > 99 || patch > 999) return `${text}: the versionCode leaves room for major ≤ 20, minor ≤ 99 and patch ≤ 999`;
  if (nightly !== null && (nightly < 1 || nightly >= STABLE_SLOT)) return `${text}: a nightly's number runs from 1 to ${STABLE_SLOT - 1}`;
  const code = androidVersionCode(major, minor, patch, nightly);
  if (code > MAX_VERSION_CODE) return `${text}: versionCode ${code} is above Android's limit`;
  if (code <= LAB_VERSION_CODE) return `${text}: versionCode ${code} isn't above the lab builds' ${LAB_VERSION_CODE}`;
  return null;
}

const androidVersionCode = (major: number, minor: number, patch: number, nightly: number | null) => major * 100_000_000 + minor * 1_000_000 + patch * 1_000 + (nightly ?? STABLE_SLOT);

export function parseAndroidRelease(text: unknown): AndroidRelease | null {
  if (androidReleaseProblem(text) !== null) return null;
  const match = RELEASE.exec(text as string)!;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const nightly = match[4] === undefined ? null : Number(match[4]);
  return { text: text as string, major, minor, patch, nightly, code: androidVersionCode(major, minor, patch, nightly), channel: nightly === null ? "stable" : "nightly" };
}

export function androidRelease(text: string): AndroidRelease {
  const problem = androidReleaseProblem(text);
  if (problem !== null) throw new Error(problem);
  return parseAndroidRelease(text)!;
}

export const compareAndroidReleases = (a: AndroidRelease, b: AndroidRelease) => a.code - b.code;
