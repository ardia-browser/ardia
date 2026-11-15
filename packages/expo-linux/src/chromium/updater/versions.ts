export type Channel = "stable" | "nightly";
export type Release = { tag_name: string; html_url: string; prerelease: boolean; draft: boolean; assets?: { name: string }[] };

function versionParts(version: string): { numbers: number[]; nightly: number | null } {
  const [core = "", pre = ""] = version.replace(/^(linux-)?v/, "").split("-");
  const nightly = /nightly\.(\d+)/.exec(pre);
  return { numbers: core.split(".").map((part) => Number(part) || 0), nightly: nightly ? Number(nightly[1]) : pre ? 0 : null };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.nightly === right.nightly) return 0;
  if (left.nightly === null) return 1;
  if (right.nightly === null) return -1;
  return Math.sign(left.nightly - right.nightly);
}

const hasLinuxBuild = (release: Release) => (release.assets ?? []).some((asset) => /\.(AppImage|deb)$/.test(asset.name));

export function newestOf(releases: Release[], wanted: Channel): Release | null {
  const kept = releases.filter((release) => !release.draft && hasLinuxBuild(release) && (wanted === "nightly" || !release.prerelease));
  kept.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return kept[0] ?? null;
}
