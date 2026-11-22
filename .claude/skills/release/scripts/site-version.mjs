#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version] = process.argv.slice(2);
const stable = /^\d+\.\d+\.\d+$/.test(version ?? "");
const nightly = /^\d+\.\d+\.\d+-nightly\.\d+$/.test(version ?? "");
if (!stable && !nightly) {
  console.error(
    "usage: site-version.mjs <version>: points the site's downloads at that published release (a stable moves the Mac and README downloads, any release with a Linux tarball moves the Linux one)",
  );
  process.exit(64);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const repo = "ardia-browser/ardia";
const assets = JSON.parse(execFileSync("gh", ["release", "view", `v${version}`, "-R", repo, "--json", "assets"], { encoding: "utf8" })).assets;
const releasePath = `${root}/apps/site/src/data/release.json`;
const release = JSON.parse(readFileSync(releasePath, "utf8"));

const linuxName = `Ardia-${version}-linux-x64.tar.xz`;
if (assets.some((asset) => asset.name === linuxName)) release.linux = version;
else console.log(`note: v${version} has no ${linuxName}, so the Linux download stays on ${release.linux}`);

if (nightly) {
  writeFileSync(releasePath, `${JSON.stringify(release)}\n`);
  console.log(`site: Linux ${release.linux}; the Mac download stays on ${release.version}`);
  process.exit(0);
}

const dmgName = `Ardia-${version}.dmg`;
const dmg = assets.find((asset) => asset.name === dmgName);
if (!dmg) {
  console.error(`v${version} has no ${dmgName}: publish it first`);
  process.exit(1);
}

writeFileSync(releasePath, `${JSON.stringify({ ...release, version, dmgBytes: dmg.size })}\n`);

const megabytes = Math.round(dmg.size / 1e6);
const readmePath = `${root}/README.md`;
const readme = readFileSync(readmePath, "utf8");
const updated = readme
  .replace(/releases\/(?:latest\/download|download\/v[\d.]+)\/Ardia-[\d.]+\.dmg/g, `releases/download/v${version}/${dmgName}`)
  .replace(/Download Ardia [\d.]+/g, `Download Ardia ${version}`)
  .replace(/\d+ MB DMG/g, `${megabytes} MB DMG`)
  .replace(/It’s \d+ MB/g, `It’s ${megabytes} MB`);
writeFileSync(readmePath, updated);
console.log(`site and README: Ardia ${version}, ${megabytes} MB (${dmg.size} bytes); Linux ${release.linux}`);
