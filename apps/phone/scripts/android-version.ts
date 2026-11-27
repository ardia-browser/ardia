// android-version.ts [release version]
// Prints the Android app's versionName, versionCode and channel for a release version, one key=value a line: a
// stable 0.2.47 or a nightly 0.2.47-nightly.2, and without one the Mac app's MARKETING_VERSION, as release-ios
// takes. The name is the release version itself. The code is main's release-channel formula (14a4f71f7): major·10^8 +
// minor·10^6 + patch·10^3 + the nightly's number (999 for a stable), so every nightly of a version sorts below that
// version's stable and above the stable before it. Limits: major ≤ 20, minor ≤ 99, patch ≤ 999, nightly 1 to 998.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidRelease } from "../src/lib/androidRelease.ts";

export type AndroidVersion = { name: string; code: number; channel: "stable" | "nightly" };

export function androidVersion(release: string): AndroidVersion {
  const parsed = androidRelease(release.trim());
  return { name: parsed.text, code: parsed.code, channel: parsed.channel };
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
