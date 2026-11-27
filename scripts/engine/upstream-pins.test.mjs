import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ISSUE_LABEL,
  ISSUE_MARKER,
  ISSUE_TITLE,
  RateLimited,
  WORKFLOW_BOT,
  checkPinConsistency,
  closeMarker,
  commentHistory,
  compare,
  compareVersions,
  fetchUpstream,
  findTrackingIssue,
  makeClient,
  parseEnvExports,
  parseIni,
  pinsFromFiles,
  planIssue,
  readPins,
  renderIssueBody,
  renderReport,
  reopenMarker,
  stateOf,
  stateToken,
  syncIssue,
} from "./upstream-pins.mjs";

const SCRIPT = fileURLToPath(new URL("./upstream-pins.mjs", import.meta.url));
const HC = "f32f2c066787492b9ba112dc1be1ad230b53658a";
const SOURCE = "38e436c33f5ff1174eb0e2125c189b6e241ed8d3";
const BOT = { login: "github-actions[bot]", type: "Bot" };
const HUMAN = { login: "someone", type: "User" };

const windowsIni = (heliumChromium, heliumWindows, commit = HC) => `[chromium]
version = 158.0.8127.36

[helium-chromium]
tag = ${heliumChromium}
commit = ${commit}

[helium-windows]
tag = ${heliumWindows}
commit = 35ea155749e86c5bca6d5c80034709b0fe762432
`;

const FILES = {
  env: [
    'export CB="${AC_CHROMIUM_BUILD:-$HOME/chromium-build}"',
    "export CHROMIUM_VERSION=158.0.8127.36",
    "export HELIUM_TAG=0.22.2",
    "export HELIUM_MACOS_TAG=0.22.2.1",
    'export HELIUM_DIR="$CB/helium"',
    "export HELIUM_LINUX_TAG=0.22.2.1",
  ].join("\n"),
  macLinuxIni: `[chromium]
version = 158.0.8127.36

[helium-chromium]
url = https://github.com/imputnet/helium-chromium.git
tag = 0.22.2
commit = ${HC}

[helium-macos]
tag = 0.22.2.1
commit = 3a89c36d8835fa94b11a57df8cc54afc1d4eec8a

[helium-linux]
tag = 0.22.2.1
commit = d77f716db31b6009e88c75ce94d5a2bf21794286
helium_chromium_commit = ${HC}
`,
  windowsIni: windowsIni("0.22.2", "0.22.2.1"),
  windowsPrebuilt: JSON.stringify({ release: "windows-engine-20261119-1", chromium: "158.0.8127.36", source: SOURCE }),
};

const CURRENT = {
  latest: { "helium-chromium": "0.22.2", "helium-macos": "0.22.2.1", "helium-linux": "0.22.2.1", "helium-windows": "0.22.2.1" },
  heliumChromiumChromium: "158.0.8127.36",
  chromiumStable: "159.0.8154.13",
  prebuilt: { heliumChromium: "0.22.2", heliumWindows: "0.22.2.1" },
  errors: [],
};

const pins = (edit = (files) => files) => pinsFromFiles(edit({ ...FILES }));
const upstreamWith = (changes) => ({ ...CURRENT, ...changes, latest: { ...CURRENT.latest, ...(changes.latest ?? {}) } });
const partOf = (report, platform, part) => report.platforms.find((p) => p.id === platform).parts.find((x) => x.part === part);

test("ini and env.sh parsing reads the pinned values and skips derived exports", () => {
  assert.deepEqual(parseIni("[a]\nx = 1\n; note\n[b]\ny=two = three\n"), { a: { x: "1" }, b: { y: "two = three" } });
  const env = parseEnvExports(FILES.env);
  assert.equal(env.CHROMIUM_VERSION, "158.0.8127.36");
  assert.equal(env.HELIUM_MACOS_TAG, "0.22.2.1");
  assert.equal(env.CB, undefined);
  assert.equal(env.HELIUM_DIR, undefined);
});

test("version order is numeric per dotted part and anything else is unknown", () => {
  assert.equal(compareVersions("0.22.2.1", "0.22.10.1"), -1);
  assert.equal(compareVersions("158.0.8127.36", "158.0.8127.36"), 0);
  assert.equal(compareVersions("0.22.2", "0.22.2.0"), 0);
  assert.equal(compareVersions("159.0.1.0", "158.9.9999.99"), 1);
  assert.equal(stateOf("0.22.1", "0.22.2"), "behind");
  assert.equal(stateOf("0.22.3", "0.22.2"), "ahead");
  assert.equal(stateOf("0.22.2", null), "unknown");
  assert.equal(stateOf("0.22.2", ""), "unknown");
  assert.equal(stateOf("0.22.2", "0.23.0-beta"), "unknown");
  assert.equal(stateOf("0.22.2.foo", "0.22.2.1"), "unknown");
});

test("the fixture pins agree", () => {
  assert.deepEqual(checkPinConsistency(pins()), []);
});

test("a published Windows engine on an older Chromium than the pins is not a disagreement", () => {
  const older = pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "157.0.1.2", source: SOURCE }) }));
  assert.deepEqual(checkPinConsistency(older), []);
  assert.equal(partOf(compare(older, CURRENT), "windows", "chromium").state, "current");
});

test("a Windows engine whose chromium differs from the pins at its source commit is a disagreement", () => {
  const stale = pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "157.0.1.2", source: SOURCE }) }));
  const atSource = windowsIni("0.22.2", "0.22.2.1");
  const problems = checkPinConsistency(stale, { windowsIniAtSource: atSource });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /prebuilt\.json chromium 157\.0\.1\.2 doesn't match scripts\/windows\/engine\/helium-pins\.ini \[chromium\] version 158\.0\.8127\.36 at its source/);
  const matching = pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "158.0.8127.36", source: SOURCE }) }));
  assert.deepEqual(checkPinConsistency(matching, { windowsIniAtSource: atSource }), []);
});

test("the repository's pin files agree with each other", () => {
  assert.deepEqual(checkPinConsistency(readPins()), []);
});

test("the consistency check names each file that disagrees", () => {
  const chromium = checkPinConsistency(pins((f) => ({ ...f, windowsIni: f.windowsIni.replace("version = 158.0.8127.36", "version = 157.0.1.2") })));
  assert.equal(chromium.length, 1);
  assert.match(chromium[0], /Chromium version: scripts\/windows\/engine\/helium-pins\.ini \[chromium\] version is 157\.0\.1\.2/);

  const newerPrebuilt = checkPinConsistency(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "159.0.1.2", source: SOURCE }) })));
  assert.equal(newerPrebuilt.length, 1);
  assert.match(newerPrebuilt[0], /Chromium version: scripts\/windows\/engine\/prebuilt\.json chromium 159\.0\.1\.2 is newer than engine\/patches\/build\/env\.sh CHROMIUM_VERSION 158\.0\.8127\.36/);

  const commit = checkPinConsistency(pins((f) => ({ ...f, windowsIni: windowsIni("0.22.2", "0.22.2.1", "a".repeat(40)) })));
  assert.equal(commit.length, 1);
  assert.match(commit[0], /helium-chromium commit: scripts\/windows\/engine\/helium-pins\.ini/);

  const linuxBase = checkPinConsistency(pins((f) => ({ ...f, macLinuxIni: f.macLinuxIni.replace(`helium_chromium_commit = ${HC}`, `helium_chromium_commit = ${"b".repeat(40)}`) })));
  assert.match(linuxBase.join("\n"), /helium_chromium_commit is b{40}/);

  const tag = checkPinConsistency(pins((f) => ({ ...f, env: f.env.replace("HELIUM_TAG=0.22.2", "HELIUM_TAG=0.22.3") })));
  assert.match(tag.join("\n"), /helium-chromium tag: engine\/patches\/build\/helium-pins\.ini \[helium-chromium\] tag is 0\.22\.2 but engine\/patches\/build\/env\.sh HELIUM_TAG is 0\.22\.3/);
  assert.match(tag.join("\n"), /helium-macos tag 0\.22\.2\.1 is not a release of helium-chromium 0\.22\.3/);

  const macTag = checkPinConsistency(pins((f) => ({ ...f, env: f.env.replace("HELIUM_MACOS_TAG=0.22.2.1", "HELIUM_MACOS_TAG=0.22.2.2") })));
  assert.match(macTag.join("\n"), /helium-macos tag: engine\/patches\/build\/helium-pins\.ini \[helium-macos\] tag is 0\.22\.2\.1/);

  const missing = checkPinConsistency(pins((f) => ({ ...f, windowsIni: "[chromium]\nversion = 158.0.8127.36\n" })));
  assert.ok(missing.includes("scripts/windows/engine/helium-pins.ini [helium-windows] tag is missing"));

  const noSource = checkPinConsistency(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "158.0.8127.36" }) })));
  assert.deepEqual(noSource, ["scripts/windows/engine/prebuilt.json source is missing"]);
});

test("the lint rejects malformed tags and versions even when every file agrees", () => {
  const malformed = checkPinConsistency(
    pins((f) => ({
      ...f,
      env: f.env.replace("HELIUM_MACOS_TAG=0.22.2.1", "HELIUM_MACOS_TAG=0.22.2.foo"),
      macLinuxIni: f.macLinuxIni.replace("[helium-macos]\ntag = 0.22.2.1", "[helium-macos]\ntag = 0.22.2.foo"),
    })),
  );
  assert.deepEqual(malformed, [
    "engine/patches/build/env.sh HELIUM_MACOS_TAG 0.22.2.foo is not a dotted numeric version",
    "engine/patches/build/helium-pins.ini [helium-macos] tag 0.22.2.foo is not a dotted numeric version",
  ]);
  const shortSource = checkPinConsistency(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "158.0.8127.36", source: "38e436c" }) })));
  assert.deepEqual(shortSource, ["scripts/windows/engine/prebuilt.json source 38e436c is not a full commit hash"]);
  const arraySource = checkPinConsistency(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "158.0.8127.36", source: ["38e436c33f5ff1174eb0e2125c189b6e241ed8d3"] }) })));
  assert.deepEqual(arraySource, ['scripts/windows/engine/prebuilt.json source ["38e436c33f5ff1174eb0e2125c189b6e241ed8d3"] is not a full commit hash']);
  const longTag = checkPinConsistency(pins((f) => ({ ...f, windowsIni: windowsIni("0.22.2", "0.22.2.1.9") })));
  assert.ok(longTag.some((problem) => problem.startsWith("helium-windows tag 0.22.2.1.9 is not a release of helium-chromium 0.22.2")), longTag.join("\n"));
});

test("--check passes offline on the repository", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } });
  assert.match(out, /the pin files agree/);
});

test("every platform is current when upstream and the published engine match the pins", () => {
  const report = compare(pins(), CURRENT);
  assert.deepEqual(report.platforms.map((p) => [p.id, p.state]), [["macos", "current"], ["linux", "current"], ["windows", "current"]]);
  assert.equal(report.complete, true);
  assert.equal(report.behind, false);
  assert.equal(report.chromiumStable, "159.0.8154.13");
  assert.match(renderReport(report), /Summary: macOS current, Linux current, Windows current\./);
  assert.match(renderReport(report), /Chromium stable is 159\.0\.8154\.13 \(context only/);
});

test("a published Windows engine built from older Helium is behind even when the build pins are current", () => {
  const report = compare(pins(), upstreamWith({ prebuilt: { heliumChromium: "0.22.1", heliumWindows: "0.22.1.1" } }));
  assert.deepEqual(partOf(report, "windows", "windows-prebuilt"), { part: "windows-prebuilt", pinned: "0.22.1.1", upstream: "0.22.2.1", state: "behind" });
  assert.equal(partOf(report, "windows", "helium-windows").state, "current");
  assert.equal(report.platforms.find((p) => p.id === "windows").state, "behind");
  assert.equal(report.behind, true);
  assert.match(planIssue(report, null).body, /- Windows: published engine \(helium-windows at prebuilt\.json's source\) 0\.22\.1\.1 → 0\.22\.2\.1/);
});

test("the published engine is held to upstream when upstream is newer than our build pins", () => {
  const report = compare(pins(), upstreamWith({ latest: { "helium-windows": "0.22.2.3" } }));
  assert.equal(partOf(report, "windows", "windows-prebuilt").upstream, "0.22.2.3");
  assert.equal(partOf(report, "windows", "windows-prebuilt").state, "behind");
});

test("a new platform release marks only that platform behind", () => {
  const report = compare(pins(), upstreamWith({ latest: { "helium-linux": "0.22.2.2" } }));
  assert.deepEqual(report.platforms.map((p) => [p.id, p.state]), [["macos", "current"], ["linux", "behind"], ["windows", "current"]]);
  assert.deepEqual(partOf(report, "linux", "helium-linux"), { part: "helium-linux", pinned: "0.22.2.1", upstream: "0.22.2.2", state: "behind" });
});

test("a new helium-chromium on a new Chromium puts every platform behind", () => {
  const report = compare(
    pins(),
    upstreamWith({ latest: { "helium-chromium": "0.23.0", "helium-macos": "0.23.0.1" }, heliumChromiumChromium: "159.0.8154.13" }),
  );
  assert.ok(report.platforms.every((p) => p.state === "behind"));
  assert.ok(report.platforms.every((p) => p.parts.find((part) => part.part === "chromium").state === "behind"));
  assert.equal(partOf(report, "linux", "helium-linux").state, "current");
});

test("an unreadable upstream value is unknown, never hidden behind a behind platform, and writes nothing", () => {
  const report = compare(
    pins(),
    upstreamWith({ latest: { "helium-chromium": "0.23.0", "helium-macos": "0.23.0.1", "helium-linux": "0.23.0.1", "helium-windows": "0.23.0.1" }, heliumChromiumChromium: null }),
  );
  assert.equal(report.behind, true);
  assert.equal(report.complete, false);
  assert.ok(report.platforms.every((p) => p.state === "unknown"));
  assert.equal(planIssue(report, null).action, "fail");
  assert.equal(planIssue(report, { number: 9, state: "open", body: "x", user: BOT }).action, "fail");

  const noPrebuilt = compare(pins(), upstreamWith({ prebuilt: null }));
  assert.equal(partOf(noPrebuilt, "windows", "windows-prebuilt").state, "unknown");
  assert.equal(planIssue(noPrebuilt, null).action, "fail");
});

test("pin files that disagree fail the comparison even when env.sh matches upstream", () => {
  const stale = pins((f) => ({ ...f, macLinuxIni: f.macLinuxIni.replace("[helium-macos]\ntag = 0.22.2.1", "[helium-macos]\ntag = 0.22.1.1") }));
  const report = compare(stale, CURRENT);
  assert.equal(report.complete, false);
  assert.equal(partOf(report, "macos", "helium-macos").state, "unknown");
  assert.equal(partOf(report, "macos", "helium-macos").pinned, "0.22.2.1 ≠ 0.22.1.1");
  assert.ok(report.pinProblems.length > 0);
  assert.match(renderReport(report), /Pin files disagree: helium-macos tag/);
  const plan = planIssue(report, { number: 9, state: "open", body: "x", user: BOT });
  assert.equal(plan.action, "fail");
  assert.match(plan.reason, /pin files disagree/);

  const newerWindows = compare(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "159.0.1.2", source: SOURCE }) })), CURRENT);
  assert.equal(newerWindows.complete, false);
});

test("a platform whose latest release is missing makes that pin unknown and fails the run", () => {
  const report = compare(pins(), upstreamWith({ latest: { "helium-macos": null } }));
  assert.equal(partOf(report, "macos", "helium-macos").state, "unknown");
  assert.equal(report.platforms.find((p) => p.id === "macos").state, "unknown");
  assert.equal(report.complete, false);
  assert.equal(planIssue(report, null).action, "fail");
});

test("pins newer than the latest release read as ahead, and the close comment says so", () => {
  const report = compare(pins(), upstreamWith({ latest: { "helium-macos": "0.22.1.1" } }));
  assert.equal(report.platforms.find((p) => p.id === "macos").state, "ahead");
  assert.equal(report.behind, false);
  const close = planIssue(report, { number: 9, state: "open", body: "x", user: BOT });
  assert.equal(close.action, "close");
  const comment = close.steps.find((step) => step.kind === "comment").body;
  assert.doesNotMatch(comment, /Every engine pin/);
  assert.match(comment, /No engine pin is behind upstream any more/);
  assert.match(comment, /- macOS: helium-macos 0\.22\.2\.1 → 0\.22\.1\.1/);
});

test("the issue is opened, updated, reopened, left alone or closed from the report", () => {
  const behind = compare(pins(), upstreamWith({ latest: { "helium-windows": "0.22.2.3" } }));
  const create = planIssue(behind, null);
  assert.equal(create.action, "create");
  assert.equal(create.title, ISSUE_TITLE);
  assert.deepEqual(create.labels, [ISSUE_LABEL]);
  assert.ok(create.body.startsWith(ISSUE_MARKER));
  assert.match(create.body, /- Windows: helium-windows 0\.22\.2\.1 → 0\.22\.2\.3/);

  const open = { number: 9, state: "open", body: create.body, user: BOT };
  assert.equal(planIssue(behind, open).action, "none");
  const update = planIssue(behind, { ...open, body: `${ISSUE_MARKER}\nold` });
  assert.deepEqual(update.steps, [{ kind: "edit", fields: { body: create.body } }]);

  const closedOnce = [{ user: BOT, body: `${closeMarker("aaaaaaaaaaaa")}\ndone` }];
  const reopen = planIssue(behind, { ...open, state: "closed", body: `${ISSUE_MARKER}\nold` }, closedOnce);
  assert.equal(reopen.action, "reopen");
  assert.deepEqual(reopen.steps[0], { kind: "edit", fields: { state: "open", body: create.body } });
  assert.ok(reopen.steps[1].body.startsWith(reopenMarker(stateToken(behind))));

  const current = compare(pins(), CURRENT);
  const close = planIssue(current, open);
  assert.equal(close.action, "close");
  assert.ok(close.steps[0].body.startsWith(closeMarker(stateToken(current))));
  assert.match(close.steps[0].body, /Every engine pin matches upstream's latest release again/);
  assert.deepEqual(close.steps[1], { kind: "edit", fields: { state: "closed", state_reason: "completed" } });
  assert.equal(planIssue(current, null).action, "none");
  assert.equal(planIssue(current, { ...open, state: "closed" }).action, "none");
});

test("the state token follows what is behind or ahead, not the run", () => {
  const a = compare(pins(), upstreamWith({ latest: { "helium-windows": "0.22.2.3" } }));
  const b = compare(pins(), upstreamWith({ latest: { "helium-windows": "0.22.2.3" }, chromiumStable: "160.0.1.1" }));
  const c = compare(pins(), upstreamWith({ latest: { "helium-windows": "0.22.2.4" } }));
  assert.match(stateToken(a), /^[0-9a-f]{12}$/);
  assert.equal(stateToken(a), stateToken(b));
  assert.notEqual(stateToken(a), stateToken(c));
});

test("only the workflow bot's issue counts: a human's issue carrying the marker is never written to", () => {
  const issues = [
    { number: 1, state: "open", body: "unrelated", labels: [{ name: "todo" }], user: BOT },
    { number: 2, state: "open", body: `${ISSUE_MARKER} x`, pull_request: {}, user: BOT },
    { number: 3, state: "closed", body: `${ISSUE_MARKER}\nold`, user: BOT },
    { number: 4, state: "open", body: `${ISSUE_MARKER}\nbody`, labels: [], user: BOT },
    { number: 5, state: "closed", body: `${ISSUE_MARKER}\nnewer`, user: BOT },
    { number: 6, state: "open", body: `${ISSUE_MARKER}\nquoted by a person`, user: HUMAN },
    { number: 8, state: "open", body: `${ISSUE_MARKER}\nlookalike`, user: { login: WORKFLOW_BOT, type: "User" } },
  ];
  assert.equal(findTrackingIssue(issues).number, 4);
  assert.equal(findTrackingIssue(issues.filter((issue) => issue.number !== 4)).number, 5);
  assert.equal(findTrackingIssue(issues.filter((issue) => ![3, 4, 5].includes(issue.number))), null);
});

test("comment history counts only the bot's markers", () => {
  const forged = commentHistory([{ user: HUMAN, body: `${closeMarker("abc")}` }]);
  assert.equal(forged.needsReopenComment, false);
  assert.equal(forged.hasCloseComment("abc"), false);
  const cycled = commentHistory([
    { user: BOT, body: closeMarker("abc") },
    { user: BOT, body: reopenMarker("def") },
    { user: HUMAN, body: closeMarker("abc") },
  ]);
  assert.equal(cycled.needsReopenComment, false);
  assert.equal(cycled.hasCloseComment("abc"), false);
  const closedAgain = commentHistory([{ user: BOT, body: closeMarker("abc") }, { user: BOT, body: reopenMarker("def") }, { user: BOT, body: closeMarker("abc") }]);
  assert.equal(closedAgain.needsReopenComment, true);
  assert.equal(closedAgain.hasCloseComment("abc"), true);
});


function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    const route = routes.find(([pattern]) => pattern.test(`${init?.method ?? "GET"} ${url}`));
    const [, status, payload, headers = {}] = route ?? [null, 404, { message: "Not Found" }];
    const resolved = typeof payload === "function" ? payload(url) : payload;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => resolved,
      text: async () => (typeof resolved === "string" ? resolved : JSON.stringify(resolved)),
    };
  };
  return { impl, calls };
}

const RELEASES = [
  [/GET .*helium-chromium\/releases\/latest$/, 200, { tag_name: "0.22.3", draft: false, prerelease: false }],
  [/GET .*helium-macos\/releases\/latest$/, 200, { tag_name: "0.22.3.1", draft: false, prerelease: false }],
  [/GET .*helium-linux\/releases\/latest$/, 200, { tag_name: "0.22.2.1", draft: false, prerelease: false }],
  [/GET .*helium-windows\/releases\/latest$/, 200, { tag_name: "0.22.2.1", draft: false, prerelease: false }],
];

test("upstream is read from latest releases, chromium_version.txt and the published engine's source pins", async () => {
  const { impl, calls } = fakeFetch([
    ...RELEASES,
    [/GET .*helium-chromium\/contents\/chromium_version\.txt\?ref=0\.22\.3$/, 200, "158.0.8127.40\n"],
    [/GET .*\/repos\/o\/r\/contents\/scripts\/windows\/engine\/helium-pins\.ini\?ref=38e436c/, 200, windowsIni("0.22.1", "0.22.1.1")],
    [/GET https:\/\/chromiumdash/, 200, [{ version: "159.0.8154.13" }]],
  ]);
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl, prebuiltSource: SOURCE, repo: "o/r" });
  assert.deepEqual(upstream.latest, { "helium-chromium": "0.22.3", "helium-macos": "0.22.3.1", "helium-linux": "0.22.2.1", "helium-windows": "0.22.2.1" });
  assert.equal(upstream.heliumChromiumChromium, "158.0.8127.40");
  assert.equal(upstream.chromiumStable, "159.0.8154.13");
  assert.deepEqual(upstream.prebuilt, { heliumChromium: "0.22.1", heliumWindows: "0.22.1.1" });
  assert.deepEqual(upstream.errors, []);
  assert.ok(!calls.some((call) => call.url.includes("/tags")));
});

test("the published engine's pins come from the local commit first, the API only when it is missing", async () => {
  const { impl, calls } = fakeFetch([...RELEASES, [/chromium_version\.txt/, 200, "158.0.8127.36"]]);
  const readAtCommit = (commit, path) => {
    assert.equal(commit, SOURCE);
    assert.equal(path, "scripts/windows/engine/helium-pins.ini");
    return windowsIni("0.22.1", "0.22.1.1");
  };
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl, prebuiltSource: SOURCE, repo: "o/r", readAtCommit });
  assert.deepEqual(upstream.prebuilt, { heliumChromium: "0.22.1", heliumWindows: "0.22.1.1" });
  assert.ok(!calls.some((call) => call.url.includes("/repos/o/r/contents")));
});

test("a published engine whose pin file lacks its helium-chromium tag is incomplete data", async () => {
  const { impl } = fakeFetch([...RELEASES, [/chromium_version\.txt/, 200, "158.0.8127.36"]]);
  const readAtCommit = () => windowsIni("0.22.1", "0.22.1.1").replace(/\[helium-chromium\][^[]*/, "");
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl, prebuiltSource: SOURCE, repo: "o/r", readAtCommit });
  assert.equal(upstream.prebuilt, null);
  assert.ok(upstream.errors.some((error) => error.includes("helium-chromium tag null")), upstream.errors.join("\n"));
});

test("a missing latest release, a prerelease or a malformed tag is incomplete data, with no tag fallback", async () => {
  const { impl, calls } = fakeFetch([
    [/helium-chromium\/releases\/latest$/, 200, { tag_name: "0.22.3", draft: false, prerelease: false }],
    [/helium-macos\/releases\/latest$/, 404, {}],
    [/helium-linux\/releases\/latest$/, 200, { tag_name: "0.22.3.1", draft: false, prerelease: true }],
    [/helium-windows\/releases\/latest$/, 200, { tag_name: "0.22.3.foo", draft: false, prerelease: false }],
    [/helium-linux\/tags/, 200, [{ name: "0.22.9.1" }]],
    [/chromium_version\.txt/, 200, "\n"],
  ]);
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl });
  assert.deepEqual(upstream.latest, { "helium-chromium": "0.22.3" });
  assert.deepEqual(upstream.errors.sort(), [
    'chromium_version.txt at helium-chromium 0.22.3: "" is not a dotted numeric version',
    "imputnet/helium-linux: no published release",
    "imputnet/helium-macos: GET /repos/imputnet/helium-macos/releases/latest: HTTP 404",
    'imputnet/helium-windows: latest release tag "0.22.3.foo" is not a dotted numeric version',
  ]);
  assert.ok(!calls.some((call) => call.url.includes("/tags")));
  assert.equal(compare(pins(), upstream).complete, false);
});

test("primary and secondary rate limits stop the run instead of reading as an error", async () => {
  for (const [status, payload, headers] of [
    [403, {}, { "x-ratelimit-remaining": "0" }],
    [403, {}, { "retry-after": "60" }],
    [403, { message: "You have exceeded a secondary rate limit." }, {}],
    [429, {}, {}],
  ]) {
    const { impl } = fakeFetch([[/releases\/latest$/, status, payload, headers]]);
    await assert.rejects(fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl }), RateLimited);
  }
  const { impl } = fakeFetch([[/releases\/latest$/, 403, { message: "Resource not accessible by integration" }, {}]]);
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl });
  assert.equal(upstream.errors.length, 4);
});

const issuePages = (pages) => (url) => pages[Number(new URL(url).searchParams.get("page")) - 1] ?? [];
const filler = (from, count) => Array.from({ length: count }, (_, at) => ({ number: from + at, state: "closed", body: "other", labels: [], user: HUMAN }));
const writes = (calls) => calls.filter((call) => call.method !== "GET");
const sync = (fake, report, extra = {}) =>
  syncIssue({ client: makeClient({ token: "t", fetchImpl: fake.impl }), repo: "o/r", report, dryRun: false, log: () => {}, ...extra });
const behindReport = () => compare(pins(), upstreamWith({ latest: { "helium-macos": "0.22.2.2" } }));

test("syncIssue writes nothing in a dry run or on incomplete data, and opens the issue for real", async () => {
  const dry = fakeFetch([[/GET .*\/issues\?state=all/, 200, []]]);
  await sync(dry, behindReport(), { dryRun: true });
  assert.deepEqual(writes(dry.calls), []);

  const incomplete = fakeFetch([]);
  const plan = await sync(incomplete, compare(pins(), upstreamWith({ heliumChromiumChromium: null })));
  assert.equal(plan.action, "fail");
  assert.deepEqual(incomplete.calls, []);

  const disagreeing = fakeFetch([]);
  const stale = pins((f) => ({ ...f, macLinuxIni: f.macLinuxIni.replace("[helium-macos]\ntag = 0.22.2.1", "[helium-macos]\ntag = 0.22.1.1") }));
  assert.equal((await sync(disagreeing, compare(stale, CURRENT))).action, "fail");
  assert.deepEqual(disagreeing.calls, []);

  const open = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, []],
    [/POST .*\/repos\/o\/r\/issues$/, 201, { html_url: "https://github.com/o/r/issues/5" }],
  ]);
  await sync(open, behindReport());
  const created = open.calls.find((call) => call.method === "POST");
  assert.equal(created.body.title, ISSUE_TITLE);
  assert.deepEqual(created.body.labels, ["todo"]);
});

test("a human's issue carrying the marker is left alone and the bot opens its own", async () => {
  const forged = { number: 6, state: "open", body: `${ISSUE_MARKER}\nquoted`, labels: [], user: HUMAN };
  const behind = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [forged]],
    [/POST .*\/repos\/o\/r\/issues$/, 201, { html_url: "https://github.com/o/r/issues/7" }],
  ]);
  await sync(behind, behindReport());
  assert.deepEqual(writes(behind.calls).map((call) => call.url), ["https://api.github.com/repos/o/r/issues"]);

  const current = fakeFetch([[/GET .*\/issues\?state=all/, 200, [forged]]]);
  assert.equal((await sync(current, compare(pins(), CURRENT))).action, "none");
  assert.deepEqual(writes(current.calls), []);
});

test("an open tracking issue past page 10 with its label removed is updated, not duplicated", async () => {
  const pages = Array.from({ length: 12 }, (_, page) => filler(page * 100 + 100, 100));
  pages.push([{ number: 42, state: "open", body: `${ISSUE_MARKER}\nold`, labels: [], user: BOT }]);
  const run = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, issuePages(pages)],
    [/GET .*\/issues\/42\/comments/, 200, []],
    [/PATCH .*\/issues\/42$/, 200, {}],
  ]);
  const plan = await sync(run, behindReport());
  assert.equal(plan.action, "update");
  assert.equal(run.calls.filter((call) => call.url.includes("state=all")).length, 13);
  assert.deepEqual(writes(run.calls).map((call) => call.method), ["PATCH"]);
  assert.ok(run.calls.every((call) => !call.url.includes("labels=")));
});

test("the issue scan fails rather than create when it can't reach the last page", async () => {
  const run = fakeFetch([[/GET .*\/issues\?state=all/, 200, (url) => filler(Number(new URL(url).searchParams.get("page")) * 100, 100)]]);
  await assert.rejects(sync(run, behindReport(), { maxPages: 3 }), /more than 3 pages of issues/);
  assert.deepEqual(writes(run.calls), []);

  const broken = fakeFetch([[/GET .*\/issues\?state=all/, 502, {}]]);
  await assert.rejects(sync(broken, behindReport()), /HTTP 502/);
  assert.deepEqual(writes(broken.calls), []);
});

test("reopening: a retry after the reopen succeeded but its comment failed posts the comment once", async () => {
  const report = behindReport();
  const closed = { number: 7, state: "closed", body: `${ISSUE_MARKER}\nold`, labels: [], user: BOT };
  const history = [{ user: BOT, body: `${closeMarker("aaaaaaaaaaaa")}\ndone` }];

  const failing = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [closed]],
    [/GET .*\/issues\/7\/comments/, 200, history],
    [/PATCH .*\/issues\/7$/, 200, {}],
    [/POST .*\/issues\/7\/comments$/, 502, {}],
  ]);
  await assert.rejects(sync(failing, report), /HTTP 502/);
  assert.deepEqual(writes(failing.calls).map((call) => call.method), ["PATCH", "POST"]);
  assert.equal(writes(failing.calls)[0].body.state, "open");

  const reopened = { ...closed, state: "open", body: renderIssueBody(report) };
  const retry = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [reopened]],
    [/GET .*\/issues\/7\/comments/, 200, history],
    [/POST .*\/issues\/7\/comments$/, 201, {}],
  ]);
  const plan = await sync(retry, report);
  assert.equal(plan.action, "update");
  assert.deepEqual(writes(retry.calls).map((call) => call.method), ["POST"]);
  assert.ok(writes(retry.calls)[0].body.body.startsWith(reopenMarker(stateToken(report))));

  const settled = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [reopened]],
    [/GET .*\/issues\/7\/comments/, 200, [...history, { user: BOT, body: reopenMarker(stateToken(report)) }, { user: HUMAN, body: "thanks" }]],
  ]);
  assert.equal((await sync(settled, report)).action, "none");
  assert.deepEqual(writes(settled.calls), []);
});

test("closing: a retry after the comment succeeded but the close failed only closes, even after someone else comments", async () => {
  const current = compare(pins(), CURRENT);
  const token = stateToken(current);
  const open = { number: 5, state: "open", body: `${ISSUE_MARKER}\nold`, labels: [], user: BOT };

  const first = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [open]],
    [/GET .*\/issues\/5\/comments/, 200, [{ user: BOT, body: reopenMarker("bbbbbbbbbbbb") }]],
    [/POST .*\/issues\/5\/comments$/, 201, {}],
    [/PATCH .*\/issues\/5$/, 502, {}],
  ]);
  await assert.rejects(sync(first, current), /HTTP 502/);
  assert.deepEqual(writes(first.calls).map((call) => call.method), ["POST", "PATCH"]);
  assert.ok(writes(first.calls)[0].body.body.startsWith(closeMarker(token)));

  const retry = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [open]],
    [
      /GET .*\/issues\/5\/comments/,
      200,
      [{ user: BOT, body: reopenMarker("bbbbbbbbbbbb") }, { user: BOT, body: `${closeMarker(token)}\ndone` }, { user: HUMAN, body: "nice" }],
    ],
    [/PATCH .*\/issues\/5$/, 200, {}],
  ]);
  await sync(retry, current);
  assert.deepEqual(writes(retry.calls).map((call) => [call.method, call.body]), [["PATCH", { state: "closed", state_reason: "completed" }]]);

  const forgedClose = fakeFetch([
    [/GET .*\/issues\?state=all/, 200, [open]],
    [/GET .*\/issues\/5\/comments/, 200, [{ user: HUMAN, body: closeMarker(token) }]],
    [/POST .*\/issues\/5\/comments$/, 201, {}],
    [/PATCH .*\/issues\/5$/, 200, {}],
  ]);
  await sync(forgedClose, current);
  assert.deepEqual(writes(forgedClose.calls).map((call) => call.method), ["POST", "PATCH"]);
});

test("--issue refuses to write outside the workflow", () => {
  const env = { ...process.env, GITHUB_REPOSITORY: "o/r", GITHUB_ACTIONS: "", GITHUB_TOKEN: "", DRY_RUN: "" };
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--issue"], { encoding: "utf8", env, stdio: "pipe" }), /writes only from the workflow/);
});
