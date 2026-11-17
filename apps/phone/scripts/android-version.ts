// android-version.ts [release version]
// Prints the Android app's versionName, versionCode and channel for a release version, one key=value a line: a
// stable 0.2.47 or a nightly 0.2.47-nightly.2, and without one the Mac app's MARKETING_VERSION, as release-ios
// takes. The name is the release version itself. The code is main's release-channel formula (14a4f71f7): major·10^8 +
// minor·10^6 + patch·10^3 + the nightly's number (999 for a stable), so every nightly of a version sorts below that
// version's stable and above the stable before it. Limits: major ≤ 20, minor ≤ 99, patch ≤ 999, nightly 1 to 998.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AndroidVersion = { name: string; code: number; channel: "stable" | "nightly" };

const STABLE_SLOT = 999;
const LAB_CODE = 2;

export function androidVersion(release: string): AndroidVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+))?$/.exec(release.trim());
  if (!match) throw new Error(`${release} is neither a stable (<major>.<minor>.<patch>) nor a nightly (<next stable>-nightly.<n>) version`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const nightly = match[4] === undefined ? null : Number(match[4]);
  if (major > 20 || minor > 99 || patch > 999) throw new Error(`${release}: the versionCode leaves room for major ≤ 20, minor ≤ 99 and patch ≤ 999`);
  if (nightly !== null && (nightly < 1 || nightly >= STABLE_SLOT)) throw new Error(`${release}: a nightly's number runs from 1 to ${STABLE_SLOT - 1}`);
  const code = major * 100_000_000 + minor * 1_000_000 + patch * 1_000 + (nightly ?? STABLE_SLOT);
  if (code > 2_100_000_000) throw new Error(`${release}: versionCode ${code} is above Android's limit`);
  if (code <= LAB_CODE) throw new Error(`${release}: versionCode ${code} isn't above the lab builds' ${LAB_CODE}`);
  return { name: release.trim(), code, channel: nightly === null ? "stable" : "nightly" };
}

export function macMarketingVersion(root: string): string {
  const project = readFileSync(path.join(root, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj"), "utf8");
  const versions = [...new Set([...project.matchAll(/MARKETING_VERSION = "?([^";]*)"?;/g)].map((found) => found[1] ?? ""))];
  const [only] = versions;
  if (versions.length !== 1 || !only) throw new Error(`the Mac app's project has ${versions.length === 0 ? "no" : "more than one"} MARKETING_VERSION: ${versions.join(" ")}`);
  return only;
}

function main(args: string[]) {
  if (args[0] === "--help" || args[0] === "-h") {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(lines.slice(0, 6).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const version = androidVersion(args[0] ?? macMarketingVersion(root));
  console.log(`name=${version.name}\ncode=${version.code}\nchannel=${version.channel}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}
