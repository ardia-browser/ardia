#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseNote } from "../lib/release-note.mjs";
import { REPO } from "../lib/repo.mjs";

const USAGE = `usage: scripts/release/preflight.mjs <version> [--mode release|dry-run|candidate] [--feed <url|path|none>]
                                     [--feed-out <path>] [--values-out <path>] [--allow-no-feed] [--github]

Checks in a few seconds what would stop the release of <version> later, with one
network request (the published appcast):
  the version fits a channel; docs/release-notes/<version>.md exists, has a body
  and its frontmatter reads; MARKETING_VERSION, CURRENT_PROJECT_VERSION and
  MACOSX_DEPLOYMENT_TARGET each have exactly one value in the macOS project and
  MARKETING_VERSION is <version>; Info.plist takes both from the build settings;
  the Arch package update-pkgbuild.sh writes for <version> has the right pkgver
  and tarball, and the committed .SRCINFO matches its PKGBUILD; the build number
  is above every build in the feed, stable and nightly.

  --mode release     everything fails (the default)
  --mode dry-run     everything fails except a nightly that is already released and
                     still the newest build (publish.sh --dry-run takes that one; it
                     refuses a stable that isn't above the latest stable)
  --mode candidate   release.sh --rc: the version already being released only warns,
                     the notes may be missing and MARKETING_VERSION may differ (the
                     candidate then takes the next build number)
  --feed             the published appcast: a URL, a file or none (default
                     $APPCAST_BASE, else the latest release's appcast.xml)
  --feed-out         write the feed it read there (empty when there is none), for
                     release.sh to build the new appcast on
  --values-out       write the checked project values there as key=value lines
                     (project_version, project_build, release_build, min_macos, and
                     already_released: nightly-newest when a dry run let a released
                     nightly at this build through, else none)
  --allow-no-feed    a feed URL that answers 404 means no feed yet, not a failure
  --github           also print GitHub Actions ::error:: and ::warning:: lines`;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_FEED = `https://github.com/${REPO}/releases/latest/download/appcast.xml`;
const MODES = new Set(["release", "dry-run", "candidate"]);
const FETCH_TIMEOUT_MS = 4_000;
const PARSE_TIMEOUT_MS = 3_000;
const MAX_FEED_BYTES = 8 * 1024 * 1024;

export function channelOf(version) {
  if (/^\d+\.\d+\.\d+-nightly\.\d+$/.test(version)) return "nightly";
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";
  return null;
}

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function pbxSettings(text, name) {
  const values = [];
  const pattern = new RegExp(`^\\s*${name} = "?([^";]*)"?;\\s*$`, "gm");
  for (const match of text.matchAll(pattern)) values.push(match[1]);
  return { count: values.length, distinct: [...new Set(values)] };
}

function plistString(text, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return match ? match[1] : null;
}

const PARSE_FEED = `
import json, sys
import xml.etree.ElementTree as ET
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
try:
    root = ET.fromstring(sys.stdin.buffer.read())
except ET.ParseError as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(0)
channels = root.findall("channel") if root.tag == "rss" else []
if len(channels) != 1 or len(list(channels[0].iter("item"))) != len(channels[0].findall("item")):
    print(json.dumps({"error": "not one rss channel with its items directly in it"}))
    sys.exit(0)
print(json.dumps({"items": [[item.findtext(SPARKLE + "shortVersionString"), item.findtext(SPARKLE + "version"), item.findtext(SPARKLE + "channel") or "stable"] for item in channels[0].findall("item")]}))
`;

function parsedItems(xml) {
  const run = spawnSync("python3", ["-I", "-c", PARSE_FEED], { input: xml, encoding: "utf8", timeout: PARSE_TIMEOUT_MS });
  if (run.status !== 0) return null;
  const parsed = JSON.parse(run.stdout);
  return parsed.error ? null : parsed.items;
}

export function feedFacts(xml, version) {
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES || !xml.includes("xmlns:sparkle") || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) return null;
  if ((xml.match(/<channel>/g) ?? []).length !== 1 || (xml.match(/<\/channel>/g) ?? []).length !== 1) return null;
  const parsed = parsedItems(xml);
  if (!parsed || parsed.length === 0) return null;
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  if (parsed.length !== items.length) return null;
  if ((xml.match(/<item[\s>]/g) ?? []).length !== items.length || (xml.match(/<\/item\s*>/g) ?? []).length !== items.length) return null;
  let newest = null;
  let newestOther = null;
  const listedBuilds = [];
  let latestStable = null;
  for (const [index, item] of items.entries()) {
    const build = /<sparkle:version>(\d+)<\/sparkle:version>/.exec(item)?.[1];
    const short = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(item)?.[1];
    if (!build || !short || parsed[index][0] !== short || parsed[index][1] !== build) return null;
    const number = Number(build);
    const mine = short === version;
    if (mine) listedBuilds.push(number);
    newest = Math.max(newest ?? 0, number);
    if (!mine) newestOther = Math.max(newestOther ?? 0, number);
    if (!mine && parsed[index][2] === "stable" && channelOf(short) === "stable" && (latestStable === null || compareVersions(short, latestStable) > 0)) latestStable = short;
  }
  return { newest, newestOther, listed: listedBuilds.length > 0, listedBuilds, latestStable, items: items.length };
}

async function boundedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > MAX_FEED_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFeed(source, { fetchImpl, allowNoFeed }) {
  if (source === "none") return { xml: "", none: true, note: "no feed (--feed none): this release starts it" };
  if (!/^https?:\/\//.test(source)) {
    if (!existsSync(source)) return { error: `no feed file at ${source}` };
    if (statSync(source).size > MAX_FEED_BYTES) return { error: `${source} is over ${MAX_FEED_BYTES} bytes` };
    return { xml: readFileSync(source, "utf8") };
  }
  try {
    const response = await fetchImpl(source, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404 && allowNoFeed) return { xml: "", none: true, note: `${source} answers 404: no feed yet, this release starts it` };
    if (!response.ok) return { error: `${source} answered HTTP ${response.status}` };
    if (Number(response.headers?.get?.("content-length") ?? 0) > MAX_FEED_BYTES) return { error: `${source} is over ${MAX_FEED_BYTES} bytes` };
    const text = await boundedText(response);
    if (text === null) return { error: `${source} is over ${MAX_FEED_BYTES} bytes` };
    return { xml: text };
  } catch (error) {
    return { error: `couldn't fetch ${source} within ${FETCH_TIMEOUT_MS / 1000} s: ${error?.message ?? error}` };
  }
}

function archFacts(root, version) {
  const tool = join(root, "scripts/linux/arch/update-pkgbuild.sh");
  if (!existsSync(tool)) return { error: "no scripts/linux/arch/update-pkgbuild.sh" };
  const check = spawnSync("bash", [tool, "--check"], { encoding: "utf8" });
  if (check.status !== 0) return { error: (check.stderr || check.stdout).trim().split("\n").pop() };
  const out = mkdtempSync(join(tmpdir(), "ac-preflight-arch-"));
  try {
    const run = spawnSync("bash", [tool, version, "--sha256", "0".repeat(64), "--out", out], { encoding: "utf8" });
    if (run.status !== 0) return { error: (run.stderr || run.stdout).trim() };
    const srcinfo = readFileSync(join(out, ".SRCINFO"), "utf8");
    return {
      pkgver: /^\tpkgver = (.*)$/m.exec(srcinfo)?.[1] ?? "",
      source: /^\tsource = (.*)$/m.exec(srcinfo)?.[1] ?? "",
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function preflight({ version, mode = "release", feed, feedOut, valuesOut, allowNoFeed = false, root = ROOT, fetchImpl = globalThis.fetch }) {
  const results = [];
  const soft = mode !== "release";
  const pass = (message) => results.push({ level: "pass", message });
  const fail = (message) => results.push({ level: "fail", message });
  const note = (message) => results.push({ level: "note", message });

  const channel = channelOf(version);
  if (!channel) {
    fail(`${version} is neither a stable (<major>.<minor>.<patch>) nor a nightly (<next stable>-nightly.<n>) version`);
    return { results, ok: false };
  }
  pass(`version ${version} is a ${channel}`);

  const notesPath = join(root, "docs/release-notes", `${version}.md`);
  const notesName = `docs/release-notes/${version}.md`;
  if (!existsSync(notesPath)) {
    if (mode === "candidate") note(`no ${notesName}: the candidate uses a placeholder`);
    else fail(`no ${notesName}: write and commit the notes first`);
  } else if (statSync(notesPath).size === 0) {
    fail(`${notesName} is empty`);
  } else {
    try {
      const parsed = releaseNote(notesPath);
      if (!parsed.body.trim()) fail(`${notesName} has frontmatter but no notes under it`);
      else pass(`${notesName}: "${parsed.headline}"`);
    } catch (error) {
      fail(error.message);
    }
  }

  const pbxPath = join(root, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj");
  const pbx = readFileSync(pbxPath, "utf8");
  const marketing = pbxSettings(pbx, "MARKETING_VERSION");
  const build = pbxSettings(pbx, "CURRENT_PROJECT_VERSION");
  const deployment = pbxSettings(pbx, "MACOSX_DEPLOYMENT_TARGET");
  let releaseBuild = null;
  const single = (setting, name) => {
    if (setting.count === 0) fail(`the macOS project sets no ${name}`);
    else if (setting.distinct.length > 1) fail(`the macOS project's configurations disagree on ${name}: ${setting.distinct.join(", ")}`);
    else return setting.distinct[0];
    return null;
  };
  const projectVersion = single(marketing, "MARKETING_VERSION");
  const projectBuild = single(build, "CURRENT_PROJECT_VERSION");
  const minMacos = single(deployment, "MACOSX_DEPLOYMENT_TARGET");
  if (marketing.count && build.count && marketing.count !== build.count) {
    fail(`the macOS project sets MARKETING_VERSION in ${marketing.count} configurations but CURRENT_PROJECT_VERSION in ${build.count}`);
  }
  if (minMacos !== null && !/^[1-9]\d*\.0$/.test(minMacos)) fail(`MACOSX_DEPLOYMENT_TARGET isn't one whole macOS version: ${minMacos}`);
  if (projectBuild !== null && !/^[1-9]\d*$/.test(projectBuild)) fail(`CURRENT_PROJECT_VERSION is ${projectBuild}, not a whole number`);
  if (projectVersion !== null && projectBuild !== null && /^[1-9]\d*$/.test(projectBuild)) {
    if (projectVersion === version) {
      releaseBuild = Number(projectBuild);
      pass(`MARKETING_VERSION ${projectVersion}, CURRENT_PROJECT_VERSION ${projectBuild}, in all ${marketing.count} configurations`);
    } else if (mode === "candidate") {
      releaseBuild = Number(projectBuild) + 1;
      note(`MARKETING_VERSION is ${projectVersion}: the candidate builds as ${version}, build ${releaseBuild}`);
    } else {
      fail(`MARKETING_VERSION is ${projectVersion}: commit the bump to ${version} (and CURRENT_PROJECT_VERSION) first`);
    }
  }

  const plist = readFileSync(join(root, "apps/browser/macos/Ardia-macOS/Info.plist"), "utf8");
  const shortVersion = plistString(plist, "CFBundleShortVersionString");
  const bundleVersion = plistString(plist, "CFBundleVersion");
  if (shortVersion !== "$(MARKETING_VERSION)") fail(`Info.plist's CFBundleShortVersionString is ${shortVersion}, not $(MARKETING_VERSION)`);
  if (bundleVersion !== "$(CURRENT_PROJECT_VERSION)") fail(`Info.plist's CFBundleVersion is ${bundleVersion}, not $(CURRENT_PROJECT_VERSION)`);
  if (shortVersion === "$(MARKETING_VERSION)" && bundleVersion === "$(CURRENT_PROJECT_VERSION)") pass("Info.plist takes its version and build from the build settings");

  const arch = archFacts(root, version);
  const pkgver = version.replace("-nightly", "nightly");
  const tarball = `https://github.com/${REPO}/releases/download/v${version}/Ardia-${version}-linux-x64.tar.xz`;
  if (arch.error) fail(`Arch package: ${arch.error}`);
  else if (arch.pkgver !== pkgver) fail(`Arch package: update-pkgbuild.sh writes pkgver ${arch.pkgver} for ${version}, not ${pkgver}`);
  else if (arch.source !== `ardia-bin-${pkgver}.tar.xz::${tarball}`) fail(`Arch package: its source is ${arch.source}, not ${tarball}`);
  else pass(`Arch package: pkgver ${pkgver}, from v${version}'s tarball`);

  let alreadyReleased = "none";
  const source = feed ?? process.env.APPCAST_BASE ?? DEFAULT_FEED;
  const read = await readFeed(source, { fetchImpl, allowNoFeed });
  let xml = "";
  if (read.error) {
    if (mode === "candidate") note(`${read.error}: the candidate's appcast starts from nothing`);
    else fail(`${read.error}: every release builds on the published appcast, or earlier versions and the other channel drop out of the feed`);
  } else if (read.none) {
    note(read.note);
  } else if (!read.xml.trim()) {
    fail(`${source} is empty: only --feed none, or a 404 with --allow-no-feed, means there is no feed yet`);
  } else {
    xml = read.xml;
  }
  if (xml) {
    const facts = feedFacts(xml, version);
    if (!facts) {
      fail(`${source} isn't a whole Sparkle appcast as appcast.py reads one (not well-formed XML, a DTD, not one plain <channel> with its items directly in it, no items, or an item without its version and build)`);
      xml = "";
    } else if (releaseBuild !== null) {
      if (facts.newestOther === null || releaseBuild > facts.newestOther) {
        pass(`build ${releaseBuild} is above every other build in the feed (${facts.items} items, newest other ${facts.newestOther ?? "none"})`);
      } else {
        fail(`the build number (${releaseBuild}) must be above every build in the feed, nightly or stable (newest: ${facts.newestOther}): bump CURRENT_PROJECT_VERSION`);
      }
      if (channel === "stable" && facts.latestStable && compareVersions(version, facts.latestStable) <= 0) {
        const message = `${version} isn't above the latest stable release in the feed (${facts.latestStable}): publish.sh refuses it, publishing it as latest would move every download and feed backward`;
        if (mode === "candidate") results.push({ level: "warn", message });
        else fail(message);
      }
      if (facts.listed) {
        const message = `the feed already lists ${version}`;
        const sameBuild = facts.listedBuilds.every((build) => build === releaseBuild);
        if (mode === "dry-run" && channel === "nightly" && sameBuild) alreadyReleased = "nightly-newest";
        if (mode === "candidate" || (mode === "dry-run" && channel === "nightly" && sameBuild)) results.push({ level: "warn", message: `${message} (a real release would stop here)` });
        else if (mode === "dry-run" && channel === "nightly") fail(`${message} as build ${facts.listedBuilds.join(", ")}, not ${releaseBuild}: publish.sh --dry-run would keep both items and refuse the feed`);
        else if (mode === "dry-run") fail(`${message}: publish.sh --dry-run refuses a stable that isn't above the latest stable release, so this dry run would fail at its end`);
        else fail(message);
      }
    }
  }
  if (feedOut) writeFileSync(feedOut, xml);
  const ok = !results.some((result) => result.level === "fail");
  if (valuesOut && ok) {
    writeFileSync(valuesOut, `project_version=${projectVersion}\nproject_build=${projectBuild}\nrelease_build=${releaseBuild}\nmin_macos=${minMacos.split(".")[0]}\nalready_released=${alreadyReleased}\n`);
  }

  return { results, ok, channel, releaseBuild };
}

function parseArgs(argv) {
  const options = { mode: "release", github: false, allowNoFeed: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--mode") options.mode = value();
    else if (arg === "--feed") options.feed = value();
    else if (arg === "--feed-out") options.feedOut = value();
    else if (arg === "--values-out") options.valuesOut = value();
    else if (arg === "--allow-no-feed") options.allowNoFeed = true;
    else if (arg === "--github") options.github = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (!options.help && positional.length !== 1) throw new Error("pass one version");
  if (!MODES.has(options.mode)) throw new Error(`--mode is release, dry-run or candidate, got ${options.mode}`);
  options.version = positional[0];
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}\n${USAGE}`);
    process.exit(64);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const started = Date.now();
  const { results, ok } = await preflight(options);
  const labels = { pass: "PASS", fail: "FAIL", warn: "WARN", note: "NOTE" };
  for (const { level, message } of results) {
    (level === "fail" ? console.error : console.log)(`${labels[level]}  ${message}`);
    if (options.github && level === "fail") console.log(`::error::${message}`);
    if (options.github && level === "warn") console.log(`::warning::${message}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!ok) {
    console.error(`preflight: ${options.version} can't be released (${options.mode}, ${seconds} s)`);
    process.exit(1);
  }
  console.log(`preflight: ${options.version} is clear (${options.mode}, ${seconds} s)`);
}
