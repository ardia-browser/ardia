import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { channelOf, feedFacts, pbxSettings, preflight } from "./preflight.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = join(root, "scripts/release/preflight.mjs");
const PBX = "apps/browser/macos/Ardia.xcodeproj/project.pbxproj";
const PLIST = "apps/browser/macos/Ardia-macOS/Info.plist";

function config(name, version, build) {
  return `\t\tA${name} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCURRENT_PROJECT_VERSION = ${build};
\t\t\t\tMACOSX_DEPLOYMENT_TARGET = 15.0;
\t\t\t\tMARKETING_VERSION = ${version};
\t\t\t};
\t\t\tname = ${name};
\t\t};
`;
}

function feed(items) {
  const body = items
    .map(([version, build, channel]) => `        <item>
            <title>${version}</title>
            <sparkle:version>${build}</sparkle:version>
            <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
${channel ? `            <sparkle:channel>${channel}</sparkle:channel>\n` : ""}        </item>
`)
    .join("");
  return `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Ardia</title>
${body}    </channel>
</rss>
`;
}

const LIVE = feed([
  ["1.2.3-nightly.2", 41, "nightly"],
  ["1.2.2", 40],
  ["1.2.3-nightly.1", 39, "nightly"],
]);

function fixture({ version = "1.2.3", builds = [42, 42], versions, notes = "---\ndate: 2026-11-22\nheadline: A test release.\n---\n\n- A fix.\n", plistVersion = "$(MARKETING_VERSION)", plistBuild = "$(CURRENT_PROJECT_VERSION)" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ac-preflight-"));
  const marketing = versions ?? builds.map(() => version);
  mkdirSync(dirname(join(dir, PBX)), { recursive: true });
  writeFileSync(
    join(dir, PBX),
    `// !$*UTF8*$!\n{\n\tobjects = {\n${builds.map((build, i) => config(i ? "Release" : "Debug", marketing[i], build)).join("")}\t};\n}\n`,
  );
  mkdirSync(dirname(join(dir, PLIST)), { recursive: true });
  writeFileSync(
    join(dir, PLIST),
    `<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${plistVersion}</string>\n\t<key>CFBundleVersion</key>\n\t<string>${plistBuild}</string>\n</dict>\n</plist>\n`,
  );
  mkdirSync(join(dir, "docs/release-notes"), { recursive: true });
  if (notes !== null) writeFileSync(join(dir, `docs/release-notes/${version}.md`), notes);
  mkdirSync(join(dir, "scripts/linux/arch"), { recursive: true });
  for (const name of ["update-pkgbuild.sh", "PKGBUILD", ".SRCINFO"]) copyFileSync(join(root, "scripts/linux/arch", name), join(dir, "scripts/linux/arch", name));
  return dir;
}

function stubFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, text: async () => next.body ?? "" };
  };
  return { impl, calls };
}

const FEED_URL = "https://example.invalid/appcast.xml";

async function run(options) {
  const fetch = stubFetch(options.responses ?? [{ status: 200, body: LIVE }]);
  const result = await preflight({ feed: FEED_URL, fetchImpl: fetch.impl, ...options });
  const by = (level) => result.results.filter((r) => r.level === level).map((r) => r.message);
  return { ...result, fails: by("fail"), warns: by("warn"), notes: by("note"), passes: by("pass"), calls: fetch.calls };
}

test("channelOf takes stable and nightly versions only", () => {
  assert.equal(channelOf("0.2.48"), "stable");
  assert.equal(channelOf("0.2.49-nightly.3"), "nightly");
  for (const bad of ["0.2", "v0.2.48", "0.2.48-beta.1", "0.2.48-nightly", "0.2.48 "]) assert.equal(channelOf(bad), null, bad);
});

test("pbxSettings counts every configuration and quoted values", () => {
  const text = '\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t\tMARKETING_VERSION = "1.0";\n\t\t\t\tMARKETING_VERSION = 1.1;\n';
  assert.deepEqual(pbxSettings(text, "MARKETING_VERSION"), { count: 3, distinct: ["1.0", "1.1"] });
});

test("feedFacts reads the newest build of either channel and whether the version is listed", () => {
  assert.deepEqual(feedFacts(LIVE, "1.2.2"), { newest: 41, newestOther: 41, listed: true, listedBuilds: [40], latestStable: null, items: 3 });
  assert.deepEqual(feedFacts(LIVE, "1.2.3-nightly.2"), { newest: 41, newestOther: 40, listed: true, listedBuilds: [41], latestStable: "1.2.2", items: 3 });
  assert.deepEqual(feedFacts(LIVE, "1.2.3"), { newest: 41, newestOther: 41, listed: false, listedBuilds: [], latestStable: "1.2.2", items: 3 });
  assert.equal(feedFacts("<html>not found</html>", "1.2.3"), null);
});

test("a clean release passes with one fetch of the feed, and the feed is handed on", async () => {
  const root = fixture();
  const feedOut = join(root, "base.xml");
  const result = await run({ version: "1.2.3", root, feedOut });
  assert.deepEqual(result.fails, []);
  assert.equal(result.ok, true);
  assert.equal(result.releaseBuild, 42);
  assert.deepEqual(result.calls, [FEED_URL]);
  assert.equal(readFileSync(feedOut, "utf8"), LIVE);
  assert.ok(result.passes.some((m) => m.includes("pkgver 1.2.3")));
});

test("a nightly gets the pacman pkgver that sorts before its stable", async () => {
  const root = fixture({ version: "1.2.4-nightly.1" });
  const result = await run({ version: "1.2.4-nightly.1", root });
  assert.deepEqual(result.fails, []);
  assert.ok(result.passes.some((m) => m.includes("pkgver 1.2.4nightly.1, from v1.2.4-nightly.1's tarball")));
});

test("a build number at or below the feed's newest fails in every mode, a nightly's build included", async () => {
  for (const mode of ["release", "dry-run", "candidate"]) {
    const result = await run({ version: "1.2.3", root: fixture({ builds: [41, 41] }), mode });
    assert.equal(result.ok, false, mode);
    assert.match(result.fails.join("\n"), /build number \(41\) must be above every build in the feed, nightly or stable \(newest: 41\)/);
  }
});

test("configurations that disagree on the version or the build fail, even in a dry run", async () => {
  const builds = await run({ version: "1.2.3", root: fixture({ builds: [42, 43] }), mode: "dry-run" });
  assert.match(builds.fails.join("\n"), /disagree on CURRENT_PROJECT_VERSION: 42, 43/);
  const versions = await run({ version: "1.2.3", root: fixture({ versions: ["1.2.3", "1.2.2"] }), mode: "dry-run" });
  assert.match(versions.fails.join("\n"), /disagree on MARKETING_VERSION: 1.2.3, 1.2.2/);
  const unnumbered = await run({ version: "1.2.3", root: fixture({ builds: ["42a", "42a"] }), mode: "dry-run" });
  assert.match(unnumbered.fails.join("\n"), /CURRENT_PROJECT_VERSION is 42a, not a whole number/);
});

test("MARKETING_VERSION must be the version, except for a local candidate, which takes the next build", async () => {
  const root = fixture({ version: "1.2.2", notes: null });
  for (const mode of ["release", "dry-run"]) {
    const result = await run({ version: "1.2.3", root, mode });
    assert.match(result.fails.join("\n"), /MARKETING_VERSION is 1.2.2: commit the bump to 1.2.3/, mode);
    assert.match(result.fails.join("\n"), /no docs\/release-notes\/1.2.3.md/, mode);
  }
  const candidate = await run({ version: "1.2.3", root, mode: "candidate" });
  assert.deepEqual(candidate.fails, []);
  assert.equal(candidate.releaseBuild, 43);
});

test("notes that are empty, bodiless or unreadable fail", async () => {
  const empty = await run({ version: "1.2.3", root: fixture({ notes: "" }), mode: "dry-run" });
  assert.match(empty.fails.join("\n"), /1.2.3.md is empty/);
  const bodiless = await run({ version: "1.2.3", root: fixture({ notes: "---\ndate: 2026-11-22\nheadline: Hi.\n---\n\n" }), mode: "dry-run" });
  assert.match(bodiless.fails.join("\n"), /has frontmatter but no notes under it/);
  const broken = await run({ version: "1.2.3", root: fixture({ notes: "---\nheadline: Hi.\n---\n\n- x\n" }), mode: "candidate" });
  assert.match(broken.fails.join("\n"), /needs date: YYYY-MM-DD/);
});

test("an Info.plist with a hard-coded version fails", async () => {
  const result = await run({ version: "1.2.3", root: fixture({ plistVersion: "1.2.3", plistBuild: "42" }), mode: "dry-run" });
  assert.match(result.fails.join("\n"), /CFBundleShortVersionString is 1.2.3, not \$\(MARKETING_VERSION\)/);
  assert.match(result.fails.join("\n"), /CFBundleVersion is 42, not \$\(CURRENT_PROJECT_VERSION\)/);
});

test("a .SRCINFO that drifted from its PKGBUILD fails", async () => {
  const root = fixture();
  const srcinfo = join(root, "scripts/linux/arch/.SRCINFO");
  writeFileSync(srcinfo, readFileSync(srcinfo, "utf8").replace(/\tpkgrel = \d+/, "\tpkgrel = 9"));
  const result = await run({ version: "1.2.3", root, mode: "dry-run" });
  assert.match(result.fails.join("\n"), /Arch package: .*\.SRCINFO doesn't match its PKGBUILD/);
});

test("an already released nightly that is still the newest build only warns in a dry run, and stops a real release", async () => {
  const root = fixture({ version: "1.2.3-nightly.2", builds: [41, 41] });
  const dry = await run({ version: "1.2.3-nightly.2", root, mode: "dry-run" });
  assert.deepEqual(dry.fails, []);
  assert.match(dry.warns.join("\n"), /the feed already lists 1.2.3-nightly.2 \(a real release would stop here\)/);
  const real = await run({ version: "1.2.3-nightly.2", root, mode: "release" });
  assert.match(real.fails.join("\n"), /the feed already lists 1.2.3-nightly.2/);
});

test("an already released stable, or one with a newer build above it, fails a dry run, which publish.sh would refuse at its end", async () => {
  const root = fixture({ version: "1.2.2", builds: [40, 40] });
  const dry = await run({ version: "1.2.2", root, mode: "dry-run" });
  assert.match(dry.fails.join("\n"), /build number \(40\) must be above every build in the feed, nightly or stable \(newest: 41\)/);
  assert.match(dry.fails.join("\n"), /already lists 1.2.2: publish.sh --dry-run refuses a stable/);
  const candidate = await run({ version: "1.2.2", root, mode: "candidate" });
  assert.match(candidate.fails.join("\n"), /build number \(40\)/);
  const newest = feed([["1.2.2", 40]]);
  const alone = await run({ version: "1.2.2", root, mode: "candidate", responses: [{ status: 200, body: newest }] });
  assert.deepEqual(alone.fails, []);
  assert.match(alone.warns.join("\n"), /already lists 1.2.2/);
});

test("an empty feed fails unless it's --feed none or a 404 with --allow-no-feed", async () => {
  const root = fixture();
  const empty = join(root, "empty.xml");
  writeFileSync(empty, "");
  for (const mode of ["release", "dry-run"]) {
    const file = await run({ version: "1.2.3", root, mode, feed: empty });
    assert.match(file.fails.join("\n"), /empty\.xml is empty: only --feed none/, mode);
    const body = await run({ version: "1.2.3", root, mode, allowNoFeed: true, responses: [{ status: 200, body: "" }] });
    assert.match(body.fails.join("\n"), /appcast\.xml is empty/, mode);
  }
});

test("--values-out hands release.sh the values it checked, quotes and the .0 taken off", async () => {
  const root = fixture({ builds: ['"42"', '"42"'] });
  const pbx = join(root, PBX);
  writeFileSync(pbx, readFileSync(pbx, "utf8").replaceAll("MACOSX_DEPLOYMENT_TARGET = 15.0;", 'MACOSX_DEPLOYMENT_TARGET = "15.0";'));
  const valuesOut = join(root, "values");
  const result = await run({ version: "1.2.3", root, valuesOut });
  assert.deepEqual(result.fails, []);
  assert.equal(readFileSync(valuesOut, "utf8"), "project_version=1.2.3\nproject_build=42\nrelease_build=42\nmin_macos=15\nalready_released=none\n");
  const candidate = await run({ version: "1.2.4", root: fixture({ notes: null }), mode: "candidate", valuesOut });
  assert.deepEqual(candidate.fails, []);
  assert.equal(readFileSync(valuesOut, "utf8"), "project_version=1.2.3\nproject_build=42\nrelease_build=43\nmin_macos=15\nalready_released=none\n");
});

test("an unreadable feed stops a release and a dry run, while a candidate starts from nothing", async () => {
  const root = fixture();
  for (const mode of ["release", "dry-run"]) {
    const down = await run({ version: "1.2.3", root, mode, responses: [new Error("socket hang up")] });
    assert.match(down.fails.join("\n"), /couldn't fetch .*socket hang up/, mode);
    assert.equal(down.calls.length, 1, "one request");
    const html = await run({ version: "1.2.3", root, mode, responses: [{ status: 200, body: "<html></html>" }] });
    assert.match(html.fails.join("\n"), /isn't a whole Sparkle appcast/);
    const missing = await run({ version: "1.2.3", root, mode, responses: [{ status: 404 }] });
    assert.match(missing.fails.join("\n"), /answered HTTP 404/);
  }
  const feedOut = join(root, "base.xml");
  const candidate = await run({ version: "1.2.3", root, mode: "candidate", feedOut, responses: [{ status: 500 }] });
  assert.deepEqual(candidate.fails, []);
  assert.equal(readFileSync(feedOut, "utf8"), "");
});

test("--allow-no-feed takes a 404 as the first release's missing feed, and --feed none or a file needs no network", async () => {
  const root = fixture();
  const first = await run({ version: "1.2.3", root, allowNoFeed: true, responses: [{ status: 404 }] });
  assert.deepEqual(first.fails, []);
  const none = await run({ version: "1.2.3", root, feed: "none" });
  assert.deepEqual(none.fails, []);
  assert.deepEqual(none.calls, []);
  const file = join(root, "feed.xml");
  writeFileSync(file, LIVE);
  const local = await run({ version: "1.2.3", root, feed: file });
  assert.deepEqual(local.fails, []);
  assert.deepEqual(local.calls, []);
});

test("the CLI refuses a bad version and finishes the repo's own checks in under 5 seconds", () => {
  const bad = spawnSync(process.execPath, [tool, "1.2", "--feed", "none", "--github"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error::1.2 is neither/);
  const usage = spawnSync(process.execPath, [tool, "1.2.3", "--mode", "yolo"], { encoding: "utf8" });
  assert.equal(usage.status, 64);
  const pbx = readFileSync(join(root, PBX), "utf8");
  const version = pbxSettings(pbx, "MARKETING_VERSION").distinct[0];
  const started = Date.now();
  const own = spawnSync(process.execPath, [tool, version, "--mode", "candidate", "--feed", "none"], { encoding: "utf8" });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("a feed cut off, not well-formed, without items, or with items appcast.py would read differently is refused before it reaches Sparkle", async () => {
  const root = fixture();
  const cut = LIVE.slice(0, LIVE.indexOf("</item>"));
  const unclosed = LIVE.replace("</channel>", "        <item>\n            <title>half</title>\n    </channel>");
  const buildless = LIVE.replace("<sparkle:version>40</sparkle:version>", "");
  const itemless = feed([]);
  const attributed = LIVE.replace("<item>", '<item id="x">').replace("</item>", "</item >");
  const mismatched = LIVE.replace("<sparkle:shortVersionString>1.2.2</sparkle:shortVersionString>", "<sparkle:shortVersionString>1.2.2</sparkle:version>");
  const langChannel = LIVE.replace("<channel>", '<channel xml:lang="en">');
  const wrapped = LIVE.replace("        <item>", "        <group><item>").replace("</item>\n", "</item></group>\n");
  const entities = LIVE.replace("<rss", '<!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa">]>\n<rss').replace("<title>Ardia</title>", "<title>&a;</title>");
  const huge = LIVE.replace("<title>Ardia</title>", `<title>${"x".repeat(9 * 1024 * 1024)}</title>`);
  const cases = { cut, unclosed, buildless, itemless, attributed, mismatched, langChannel, wrapped, entities, huge };
  for (const [name, body] of Object.entries(cases)) {
    const feedOut = join(root, "base.xml");
    const result = await run({ version: "1.2.3", root, feedOut, mode: "dry-run", responses: [{ status: 200, body }] });
    assert.match(result.fails.join("\n"), name === "huge" ? /is over 8388608 bytes/ : /isn't a whole Sparkle appcast/, name);
    assert.equal(readFileSync(feedOut, "utf8"), "", name);
  }
  assert.equal(feedFacts(huge, "1.2.3"), null, "feedFacts refuses an oversized feed passed as a file too");
});

test("a dry run of a listed nightly whose build differs from the checkout's fails, as publish.sh would", async () => {
  const live = feed([["1.2.4-nightly.1", 140, "nightly"], ["1.2.3", 138]]);
  const result = await run({ version: "1.2.4-nightly.1", root: fixture({ version: "1.2.4-nightly.1", builds: [139, 139] }), mode: "dry-run", responses: [{ status: 200, body: live }] });
  assert.match(result.fails.join("\n"), /already lists 1.2.4-nightly.1 as build 140, not 139/);
});

test("a stable that isn't above the latest stable in the feed fails, as publish.sh would refuse it", async () => {
  const root = fixture({ version: "1.2.1", builds: [42, 42] });
  for (const mode of ["release", "dry-run"]) {
    const result = await run({ version: "1.2.1", root, mode });
    assert.match(result.fails.join("\n"), /1.2.1 isn't above the latest stable release in the feed \(1.2.2\)/, mode);
  }
  const candidate = await run({ version: "1.2.1", root, mode: "candidate" });
  assert.deepEqual(candidate.fails, []);
  assert.match(candidate.warns.join("\n"), /isn't above the latest stable/);
  const nightly = await run({ version: "1.2.1-nightly.1", root: fixture({ version: "1.2.1-nightly.1", builds: [42, 42] }) });
  assert.deepEqual(nightly.fails, []);
});

test("the 8 MB cap counts UTF-8 bytes while the body streams, and applies to a feed file too", async () => {
  const root = fixture();
  const body = LIVE.replace("<title>Ardia</title>", `<title>${"é".repeat(4_500_000)}</title>`);
  const result = await preflight({ version: "1.2.3", root, feed: FEED_URL, fetchImpl: async () => new Response(body, { status: 200 }) });
  assert.match(result.results.filter((r) => r.level === "fail").map((r) => r.message).join("\n"), /is over 8388608 bytes/);
  const file = join(root, "big.xml");
  writeFileSync(file, body);
  const local = await run({ version: "1.2.3", root, feed: file });
  assert.match(local.fails.join("\n"), /big\.xml is over 8388608 bytes/);
});

test("already_released says nightly-newest only when a dry run let a released nightly at this build through", async () => {
  const root = fixture({ version: "1.2.3-nightly.2", builds: [41, 41] });
  const valuesOut = join(root, "values");
  await run({ version: "1.2.3-nightly.2", root, mode: "dry-run", valuesOut });
  assert.match(readFileSync(valuesOut, "utf8"), /^already_released=nightly-newest$/m);
  const missing = fixture({ version: "1.2.4", builds: [42, 42] });
  await run({ version: "1.2.4", root: missing, mode: "dry-run", valuesOut, allowNoFeed: true, responses: [{ status: 404 }] });
  assert.match(readFileSync(valuesOut, "utf8"), /^already_released=none$/m);
});

function preflightStep() {
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const start = workflow.indexOf("      - id: plan\n");
  const body = workflow.slice(workflow.indexOf("        run: |\n", start) + "        run: |\n".length, workflow.indexOf("\n\n  checks:", start));
  return body.split("\n").map((line) => line.slice(10)).join("\n");
}

function runPreflightStep({ dryRun, published, alreadyReleased, version = "1.2.3-nightly.2", latest = "v1.2.2", outage = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "ac-preflight-step-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  copyFileSync(join(root, "scripts/lib/releases.sh"), join(dir, "scripts/lib/releases.sh"));
  mkdirSync(join(dir, "engine"));
  const stub = (path, body) => { writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`); chmodSync(path, 0o755); };
  stub(join(dir, "engine/engine-key.sh"), "echo 0123456789abcdef0123");
  stub(join(bin, "gh"), `case "$*" in ${outage || "never-matches"}) echo "HTTP 503: Service Unavailable (https://api.github.com/repos/ardia-browser/ardia/releases)" >&2; exit 1 ;; esac\ncase "$*" in *--json*) echo "${latest}"; exit 0 ;; esac\n${published ? "exit 0" : 'echo "release not found" >&2; exit 1'}`);
  stub(join(bin, "node"), `out=""; while [ $# -gt 0 ]; do [ "$1" = --values-out ] && out="$2"; shift; done; printf 'release_build=41\\nalready_released=${alreadyReleased}\\n' > "$out"`);
  const result = spawnSync("bash", ["-c", preflightStep()], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERSION: version, DRY_RUN: String(dryRun), IPHONE: "false", RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_REPOSITORY: "ardia-browser/ardia", GITHUB_SHA: "0".repeat(40) },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

test("the preflight job lets a dry run past a published release only for the newest nightly at this build", () => {
  const ok = runPreflightStep({ dryRun: true, published: true, alreadyReleased: "nightly-newest" });
  assert.equal(ok.status, 0, ok.output);
  assert.match(ok.output, /::warning::v1.2.3-nightly.2 is already published, as the newest nightly at this build/);
  for (const [name, options] of [
    ["a dry run the preflight didn't confirm (a 404 feed, a stable)", { dryRun: true, published: true, alreadyReleased: "none" }],
    ["a real release", { dryRun: false, published: true, alreadyReleased: "nightly-newest" }],
  ]) {
    const failed = runPreflightStep(options);
    assert.notEqual(failed.status, 0, name);
    assert.match(failed.output, /::error::v1.2.3-nightly.2 is already published/, name);
  }
  assert.equal(runPreflightStep({ dryRun: true, published: false, alreadyReleased: "none" }).status, 0);
});

test("a feed that isn't well-formed is refused before the item scan, so thousands of unclosed items cost nothing", async () => {
  const body = LIVE.replace("</channel>", `${"<item>".repeat(200_000)}</channel>`);
  const started = Date.now();
  assert.equal(feedFacts(body, "1.2.3"), null);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("the preflight job stops a stable that isn't above the latest stable tag, even when the feed answered 404", () => {
  const below = runPreflightStep({ dryRun: true, published: false, alreadyReleased: "none", version: "1.2.1", latest: "v1.2.2" });
  assert.notEqual(below.status, 0);
  assert.match(below.output, /::error::1.2.1 isn't above the latest stable release \(1.2.2\)/);
  for (const [version, latest] of [["1.2.3", "v1.2.2"], ["1.10.0", "v1.9.9"], ["1.2.1-nightly.1", "v1.2.2"]]) {
    const ok = runPreflightStep({ dryRun: true, published: false, alreadyReleased: "none", version, latest });
    assert.equal(ok.status, 0, `${version} over ${latest}: ${ok.output}`);
  }
});

test("a feed that doesn't parse fails the preflight as not a whole appcast, before any item scan", async () => {
  const body = LIVE.replace("</channel>", `${"<item>".repeat(200_000)}</channel>`);
  const result = await run({ version: "1.2.3", root: fixture(), mode: "dry-run", responses: [{ status: 200, body }] });
  assert.match(result.fails.join("\n"), /isn't a whole Sparkle appcast as appcast.py reads one/);
});

test("a GitHub outage while looking a release up stops the preflight job instead of counting as no release", () => {
  const tag = runPreflightStep({ dryRun: true, published: false, alreadyReleased: "none", outage: "*v1.2.3-nightly.2*" });
  assert.notEqual(tag.status, 0);
  assert.match(tag.output, /::error::couldn't ask GitHub whether v1.2.3-nightly.2 is published, so this stops rather than guess: HTTP 503/);
  const latest = runPreflightStep({ dryRun: true, published: false, alreadyReleased: "none", version: "1.2.3", outage: "*--json*" });
  assert.notEqual(latest.status, 0);
  assert.match(latest.output, /::error::couldn't ask GitHub for the latest release, so this stops rather than guess: HTTP 503/);
  const absent = runPreflightStep({ dryRun: false, published: false, alreadyReleased: "none", version: "1.2.3" });
  assert.equal(absent.status, 0, absent.output);
});
