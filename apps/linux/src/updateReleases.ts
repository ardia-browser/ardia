import type { UpdateChannel } from "../../../packages/shell/src/updater";

export type Release = { version: string; url: string; prerelease: boolean };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(nightly)\.(\d+))?$/;
const TAG = /^v?(\d+\.\d+\.\d+(?:-nightly\.\d+)?)$/;
const LINUX_ASSET = /-linux-x64\.(?:tar\.xz|deb|AppImage)$/;
const RELEASE_PAGE = /^https:\/\/github\.com\/ardia-browser\/ardia\/releases\/tag\/[\w.-]+$/;

export const isAppVersion = (version: unknown): version is string => typeof version === "string" && VERSION.test(version);

export const channelOf = (version: string): UpdateChannel => (VERSION.exec(version)?.[4] ? "nightly" : "stable");

export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return 0;
  for (const part of [1, 2, 3]) {
    const diff = Number(left[part]) - Number(right[part]);
    if (diff) return Math.sign(diff);
  }
  if (!left[4] && !right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  return Math.sign(Number(left[5]) - Number(right[5]));
}

export function linuxReleases(body: string): Release[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("The release list is not a list");
  return parsed.flatMap((entry): Release[] => {
    if (!entry || typeof entry !== "object" || entry.draft === true) return [];
    const tag = typeof entry.tag_name === "string" ? TAG.exec(entry.tag_name) : null;
    const url = typeof entry.html_url === "string" && RELEASE_PAGE.test(entry.html_url) ? entry.html_url : null;
    const assets: unknown[] = Array.isArray(entry.assets) ? entry.assets : [];
    const linux = assets.some((asset) => !!asset && typeof (asset as { name?: unknown }).name === "string" && LINUX_ASSET.test((asset as { name: string }).name));
    if (!tag || !url || !linux) return [];
    return [{ version: tag[1]!, url, prerelease: entry.prerelease === true || channelOf(tag[1]!) === "nightly" }];
  });
}

export function newestRelease(releases: readonly Release[], channel: UpdateChannel): Release | null {
  const offered = releases.filter((release) => channel === "nightly" || !release.prerelease);
  return offered.reduce<Release | null>((best, release) => (!best || compareVersions(release.version, best.version) > 0 ? release : best), null);
}
