import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOAT_LABEL,
  CANONICAL_REPO,
  DEFAULTS,
  FORCE_LABEL,
  HttpError,
  LIMITS_URL,
  MAIN_REF,
  forcedByLabel,
  githubPressure,
  headroomOf,
  main,
  makeFetchJson,
  overflowOf,
  pressureOf,
  report,
  route,
  runnerKind,
  settingsFrom,
  teamFrom,
  trustOf,
  withDeadline,
} from "./route-runner.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const TEAM_TEXT = "# team\nmantrakp04\nShivamHWP\n-denounced\n";
const TEAM = teamFrom(TEAM_TEXT);
const KEY = "boat_test_key_never_printed";
const TOKEN = "ghs_test_token_never_printed";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const pullRequest = (overrides = {}) => ({
  user: { login: "mantrakp04" },
  base: { ref: "main", repo: { full_name: CANONICAL_REPO } },
  head: { repo: { full_name: CANONICAL_REPO } },
  labels: [],
  ...overrides,
});

const prContext = (pr = pullRequest(), extra = {}) => ({
  eventName: "pull_request",
  repository: CANONICAL_REPO,
  ref: "refs/pull/1/merge",
  actor: "mantrakp04",
  triggeringActor: "mantrakp04",
  event: { pull_request: pr },
  ...extra,
});

const prEnv = (extra = {}) => ({
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REPOSITORY: CANONICAL_REPO,
  GITHUB_REF: "refs/pull/1/merge",
  GITHUB_ACTOR: "mantrakp04",
  GITHUB_TRIGGERING_ACTOR: "mantrakp04",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "999",
  GITHUB_TOKEN: TOKEN,
  BOAT_CI_LIMITS_KEY: KEY,
  ...extra,
});

const limits = (overrides = {}) => ({
  ok: true,
  type: "limits.info",
  canStart: true,
  startBlockedReason: null,
  activeSandboxes: 2,
  maxActiveSandboxes: 100,
  starts: {
    unlimited: false,
    minute: { limit: 10, used: 0, remaining: 10 },
    hour: { limit: 50, used: 0, remaining: 50 },
    day: { limit: 300, used: 0, remaining: 300 },
  },
  planIncluded: { vmHours: 555, vmHoursRemaining: 400 },
  wallet: { balanceDollars: 123.45 },
  machineTypes: [
    { type: "small", available: true },
    { type: "large", available: true },
  ],
  keepGoing: { mode: "fail" },
  ...overrides,
});

const job = (status, labels, createdSecondsAgo = 0) => ({ status, labels, created_at: ago(createdSecondsAgo) });

function fakeFetch({ runs = {}, jobs = {}, boat = limits(), boatStatus = 200, failRepo = {}, anonymousOk = {} } = {}) {
  const calls = [];
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === "function" ? body() : body) });
  const impl = async (url, options = {}) => {
    const headers = options.headers || {};
    calls.push({ url, authorized: Boolean(headers.Authorization), headers });
    if (url === LIMITS_URL) return typeof boat === "function" ? boat() : respond(boatStatus, boat);
    const found = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/actions\/runs(?:\/(\d+)\/jobs)?\?(.*)$/.exec(url);
    assert.ok(found, `unexpected URL ${url}`);
    const [, repo, runId, query] = found;
    if (failRepo[repo] && (headers.Authorization || !anonymousOk[repo])) return respond(failRepo[repo], { message: "nope" });
    if (runId) return respond(200, { jobs: jobs[runId] || [] });
    const params = new URLSearchParams(query);
    const list = (runs[repo] || {})[params.get("status")] || [];
    const page = Number(params.get("page") || 1);
    return respond(200, { workflow_runs: list.slice((page - 1) * 100, page * 100) });
  };
  return { impl, calls };
}

const runOf = (id, secondsAgo = 0) => ({ id, created_at: ago(secondsAgo) });

const busyGithub = () => ({
  runs: { [CANONICAL_REPO]: { queued: [runOf(1, 10)], in_progress: [runOf(999, 5)] } },
  jobs: {
    1: [job("queued", ["ubuntu-latest"], 30), job("queued", ["ubuntu-24.04"], 2), job("queued", ["windows-latest"], 2)],
    999: [job("queued", ["ubuntu-latest"], 60), job("queued", ["ubuntu-latest"], 60), job("queued", ["ubuntu-latest"], 60)],
  },
});

test("settings default to auto with the briefed thresholds", () => {
  const settings = settingsFrom({});
  assert.equal(settings.mode, "auto");
  assert.deepEqual(settings.repos, [CANONICAL_REPO, "ardia-browser/plugins"]);
  assert.equal(settings.queued, 3);
  assert.equal(settings.busy, 36);
  assert.equal(settings.queuedAge, 20);
  assert.deepEqual([settings.dayStarts, settings.hourStarts, settings.minuteStarts, settings.vmHours], [120, 20, 5, 50]);
});

test("settings read repository variables, and the step environment wins", () => {
  const vars = JSON.stringify({ BOAT_OVERFLOW: "OFF", BOAT_OVERFLOW_QUEUED: "7", BOAT_OVERFLOW_REPOS: "a/b, c/d ,bad", UNRELATED: "x" });
  const settings = settingsFrom({ BOAT_OVERFLOW_VARS: vars, BOAT_OVERFLOW_QUEUED: "9", BOAT_OVERFLOW_BUSY: "-4", BOAT_OVERFLOW_QUEUED_AGE: "0" });
  assert.equal(settings.mode, "off");
  assert.equal(settings.queued, 9);
  assert.equal(settings.busy, DEFAULTS.busy);
  assert.equal(settings.queuedAge, 0);
  assert.deepEqual(settings.repos, ["a/b", "c/d"]);
});

test("the mode is off, label or auto; anything else, and broken variables JSON, mean auto", () => {
  assert.equal(settingsFrom({ BOAT_OVERFLOW: " Label " }).mode, "label");
  assert.equal(settingsFrom({ BOAT_OVERFLOW: "auto" }).mode, "auto");
  assert.equal(settingsFrom({ BOAT_OVERFLOW: "yes please" }).mode, "auto");
  assert.equal(settingsFrom({ BOAT_OVERFLOW_VARS: "{not json" }).mode, "auto");
  assert.equal(settingsFrom({ BOAT_OVERFLOW_VARS: "null" }).queued, 3);
  assert.deepEqual(settingsFrom({ BOAT_OVERFLOW_REPOS: " , " }).repos, DEFAULTS.repos);
});

test("the team is TEAM.td's logins, lowercased, without denounced ones", () => {
  assert.deepEqual([...TEAM].sort(), ["mantrakp04", "shivamhwp"]);
  assert.deepEqual([...teamFrom("")], []);
});

test("the real TEAM.td parses to a non-empty team", () => {
  assert.ok(teamFrom(readFileSync(join(REPO, ".github/TEAM.td"), "utf8")).size > 0);
});

test("a same-repo pull request to main by a team member, started by one, is trusted", () => {
  assert.deepEqual(trustOf(prContext(), TEAM), { trusted: true, reason: "trusted" });
  assert.equal(trustOf(prContext(pullRequest({ user: { login: "ShivamHWP" } })), TEAM).trusted, true);
});

test("pull requests from forks, other bases or other repositories are not trusted", () => {
  const fork = pullRequest({ head: { repo: { full_name: "someone/ardia" } } });
  assert.equal(trustOf(prContext(fork), TEAM).reason, "untrusted-fork");
  assert.equal(trustOf(prContext(pullRequest({ head: { repo: null } })), TEAM).reason, "untrusted-fork");
  assert.equal(trustOf(prContext(pullRequest({ base: { ref: "release", repo: { full_name: CANONICAL_REPO } } })), TEAM).reason, "untrusted-base");
  assert.equal(trustOf(prContext(pullRequest({ base: { ref: "main", repo: { full_name: "x/y" } } })), TEAM).reason, "untrusted-repo");
  assert.equal(trustOf(prContext(pullRequest(), { repository: "someone/ardia" }), TEAM).reason, "untrusted-repo");
  assert.equal(trustOf(prContext(null), TEAM).reason, "untrusted-repo");
});

test("a pull request needs a team author, actor and triggering actor", () => {
  assert.equal(trustOf(prContext(pullRequest({ user: { login: "stranger" } })), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(prContext(pullRequest({ user: null })), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(prContext(pullRequest(), { actor: "stranger" }), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(prContext(pullRequest(), { triggeringActor: "stranger" }), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(prContext(pullRequest(), { actor: "denounced" }), TEAM).reason, "untrusted-actor");
});

test("a push is trusted only on main, by team actors, with a team commit author", () => {
  const push = (extra = {}) => ({
    eventName: "push",
    repository: CANONICAL_REPO,
    ref: MAIN_REF,
    actor: "mantrakp04",
    triggeringActor: "mantrakp04",
    event: { head_commit: { author: { username: "shivamhwp" } } },
    ...extra,
  });
  assert.equal(trustOf(push(), TEAM).trusted, true);
  assert.equal(trustOf(push({ ref: "refs/heads/feature" }), TEAM).reason, "untrusted-ref");
  assert.equal(trustOf(push({ triggeringActor: "stranger" }), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(push({ event: { head_commit: { author: { username: "stranger" } } } }), TEAM).reason, "untrusted-actor");
  assert.equal(trustOf(push({ event: { head_commit: { author: {} } } }), TEAM).reason, "untrusted-actor");
});

test("a manual run is trusted only on main and by team actors; other events never", () => {
  const dispatch = (extra = {}) => ({ eventName: "workflow_dispatch", repository: CANONICAL_REPO, ref: MAIN_REF, actor: "mantrakp04", triggeringActor: "shivamhwp", event: {}, ...extra });
  assert.equal(trustOf(dispatch(), TEAM).trusted, true);
  assert.equal(trustOf(dispatch({ ref: "refs/heads/mine" }), TEAM).reason, "untrusted-ref");
  assert.equal(trustOf(dispatch({ actor: "stranger" }), TEAM).reason, "untrusted-actor");
  for (const eventName of ["pull_request_target", "schedule", "workflow_run", undefined]) {
    assert.equal(trustOf(dispatch({ eventName }), TEAM).reason, "untrusted-event");
  }
});

test("only the boat-ci label on a pull request forces Boat", () => {
  assert.equal(forcedByLabel(prContext(pullRequest({ labels: [{ name: FORCE_LABEL }] }))), true);
  assert.equal(forcedByLabel(prContext(pullRequest({ labels: [{ name: "run-ci" }, null] }))), false);
  assert.equal(forcedByLabel(prContext(pullRequest({ labels: undefined }))), false);
  assert.equal(forcedByLabel({ eventName: "push", event: { pull_request: pullRequest({ labels: [{ name: FORCE_LABEL }] }) } }), false);
});

test("only standard GitHub-hosted labels count as GitHub's runners", () => {
  for (const [labels, kind] of [
    [["ubuntu-latest"], "ubuntu"],
    [["ubuntu-24.04"], "ubuntu"],
    [["ubuntu-24.04-arm"], "ubuntu"],
    [["windows-latest"], "windows"],
    [["windows-11-arm"], "windows"],
    [["macos-15"], "macos"],
    [["macos-15-xlarge"], null],
    [["macos-latest-large"], null],
    [["ubuntu-latest-large"], null],
    [["boat-large"], null],
    [["boat"], null],
    [["xcode-27"], null],
    [["self-hosted", "linux"], null],
    [[], null],
    [[7], null],
    [undefined, null],
  ]) {
    assert.equal(runnerKind(labels), kind, JSON.stringify(labels));
  }
});

test("pressure counts busy hosted jobs, and queued and long-queued ones off macOS", () => {
  const jobs = [
    job("queued", ["ubuntu-latest"], 25),
    job("queued", ["windows-latest"], 5),
    job("queued", ["macos-15"], 300),
    job("in_progress", ["ubuntu-24.04"]),
    job("in_progress", ["macos-15"]),
    job("completed", ["ubuntu-latest"]),
    job("waiting", ["ubuntu-latest"]),
    job("queued", ["boat-large"], 300),
    job("queued", ["xcode-27"], 300),
    { status: "queued", labels: ["ubuntu-latest"], created_at: "not a date" },
    null,
  ];
  assert.deepEqual(pressureOf(jobs, { now: NOW, queuedAge: 20 }), { queued: 3, busy: 6, aged: 1 });
  assert.equal(pressureOf(jobs, { now: NOW, queuedAge: 0 }).aged, 0);
});

test("GitHub overflows at the queued or busy threshold, or on one long-queued job", () => {
  const settings = settingsFrom({});
  assert.equal(overflowOf({ queued: 2, busy: 35, aged: 0 }, settings), false);
  assert.equal(overflowOf({ queued: 3, busy: 0, aged: 0 }, settings), true);
  assert.equal(overflowOf({ queued: 0, busy: 36, aged: 0 }, settings), true);
  assert.equal(overflowOf({ queued: 1, busy: 1, aged: 1 }, settings), true);
  assert.equal(overflowOf({ queued: 1, busy: 1, aged: 1 }, { ...settings, queuedAge: 0 }), false);
});

test("Boat headroom needs every reserve left after this run's starts", () => {
  const settings = settingsFrom({});
  const check = (overrides, jobs = 4) => headroomOf(limits(overrides), { jobs, settings }).reason;
  assert.equal(check({}), "boat-ok");
  assert.equal(check({ canStart: false }), "boat-low-canstart");
  assert.equal(check({ machineTypes: [{ type: "large", available: false }] }), "boat-low-machine");
  assert.equal(check({ machineTypes: [{ type: "small", available: true }] }), "boat-low-machine");
  const starts = (window, remaining) => ({ starts: { ...limits().starts, [window]: { remaining } } });
  assert.equal(check(starts("day", 124)), "boat-ok");
  assert.equal(check(starts("day", 123)), "boat-low-day-starts");
  assert.equal(check(starts("hour", 23)), "boat-low-hour-starts");
  assert.equal(check(starts("minute", 8)), "boat-low-minute-starts");
  assert.equal(check(starts("minute", 8), 3), "boat-ok");
  assert.equal(check({ planIncluded: { vmHoursRemaining: 49.9 } }), "boat-low-vm-hours");
  assert.equal(check({ activeSandboxes: 91, maxActiveSandboxes: 100 }), "boat-ok");
  assert.equal(check({ activeSandboxes: 92, maxActiveSandboxes: 100 }), "boat-low-sandboxes");
  assert.equal(check({ starts: { unlimited: true } }), "boat-ok");
});

test("Boat limits with a missing or mistyped field are malformed", () => {
  const settings = settingsFrom({});
  const malformed = (value) => headroomOf(value, { jobs: 1, settings }).reason;
  assert.equal(malformed(null), "boat-limits-malformed");
  assert.equal(malformed({}), "boat-limits-malformed");
  assert.equal(malformed(limits({ canStart: "yes" })), "boat-limits-malformed");
  assert.equal(malformed(limits({ starts: { day: { remaining: 10 } } })), "boat-limits-malformed");
  assert.equal(malformed(limits({ starts: { ...limits().starts, hour: { remaining: "50" } } })), "boat-limits-malformed");
  assert.equal(malformed(limits({ planIncluded: {} })), "boat-limits-malformed");
  assert.equal(malformed(limits({ activeSandboxes: undefined })), "boat-limits-malformed");
  assert.equal(malformed(limits({ maxActiveSandboxes: Number.NaN })), "boat-limits-malformed");
  assert.equal(malformed(limits({ machineTypes: undefined })), "boat-limits-malformed");
});

test("the GitHub read skips this run, pages, and stays inside its request budget", async () => {
  const queued = Array.from({ length: 150 }, (_, at) => runOf(at + 1, at));
  const jobs = Object.fromEntries(queued.map((run) => [run.id, [job("queued", ["ubuntu-latest"], 1)]]));
  const fake = fakeFetch({ runs: { [CANONICAL_REPO]: { queued, in_progress: [runOf(999)] } }, jobs });
  const settings = { ...settingsFrom({}), repos: [CANONICAL_REPO] };
  const pressure = await githubPressure({ fetchJson: makeFetchJson(fake.impl), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "999", now: NOW });
  assert.equal(fake.calls.length, settings.maxRequests);
  assert.equal(pressure.runs, 150);
  assert.equal(pressure.inspected, settings.maxRequests - 3);
  assert.equal(pressure.queued, settings.maxRequests - 3);
  assert.ok(!fake.calls.some((call) => call.url.includes("/runs/999/")), "this run's own jobs are not read");
  const read = fake.calls.filter((call) => call.url.includes("/jobs")).map((call) => Number(call.url.match(/runs\/(\d+)\/jobs/)[1]));
  assert.deepEqual(read.slice(0, 3), [1, 2, 3], "the newest runs are read first");
});

test("another repository that refuses the token is read anonymously; one that fails is skipped", async () => {
  const settings = settingsFrom({});
  const runs = {
    [CANONICAL_REPO]: { queued: [runOf(1)] },
    "ardia-browser/plugins": { in_progress: [runOf(2)] },
  };
  const jobs = { 1: [job("queued", ["ubuntu-latest"])], 2: [job("in_progress", ["ubuntu-latest"])] };
  const fallback = fakeFetch({ runs, jobs, failRepo: { "ardia-browser/plugins": 403 }, anonymousOk: { "ardia-browser/plugins": true } });
  const read = await githubPressure({ fetchJson: makeFetchJson(fallback.impl), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "9", now: NOW });
  assert.deepEqual([read.queued, read.busy, read.errors.length], [1, 2, 0]);
  const plugins = fallback.calls.filter((call) => call.url.includes("ardia-browser/plugins"));
  assert.ok(plugins.some((call) => !call.authorized), "plugins was read without the token");
  assert.ok(fallback.calls.filter((call) => call.url.includes(CANONICAL_REPO)).every((call) => call.authorized), "this repository is always read with the token");
  const broken = fakeFetch({ runs, jobs, failRepo: { "ardia-browser/plugins": 500 } });
  const skipped = await githubPressure({ fetchJson: makeFetchJson(broken.impl), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "9", now: NOW });
  assert.deepEqual([skipped.queued, skipped.busy], [1, 1]);
  assert.ok(skipped.errors.length > 0);
  assert.ok(!skipped.errors.join(" ").includes(TOKEN));
});

test("a malformed runs list from another repository is skipped; a failed jobs read counts nothing", async () => {
  const settings = settingsFrom({});
  const impl = async (url) => {
    if (url.includes("ardia-browser/plugins")) return { ok: true, status: 200, json: async () => ({ nope: true }) };
    if (url.includes("/jobs")) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ workflow_runs: [runOf(1)] }) };
  };
  const read = await githubPressure({ fetchJson: makeFetchJson(impl), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "9", now: NOW });
  assert.deepEqual([read.queued, read.busy], [0, 0]);
  assert.equal(read.errors.length, 3);
});

test("this repository's runs list failing, or being malformed, fails the GitHub read", async () => {
  const settings = settingsFrom({});
  const failing = fakeFetch({ failRepo: { [CANONICAL_REPO]: 403 }, anonymousOk: { [CANONICAL_REPO]: true } });
  await assert.rejects(githubPressure({ fetchJson: makeFetchJson(failing.impl), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "9", now: NOW }), HttpError);
  const malformed = async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: "no" }) });
  await assert.rejects(githubPressure({ fetchJson: makeFetchJson(malformed), token: TOKEN, settings, ownRepo: CANONICAL_REPO, ownRunId: "9", now: NOW }), /malformed/);
});

test("every request has a hard timeout", async () => {
  const hanging = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const started = Date.now();
  await assert.rejects(makeFetchJson(hanging, 50)("https://example.invalid/"));
  assert.ok(Date.now() - started < 2000);
  const decided = await withDeadline(new Promise(() => {}), 20);
  assert.deepEqual(decided, { target: "github", reason: "router-timeout" });
  assert.deepEqual(await withDeadline(Promise.resolve({ target: "boat", reason: "github-busy" }), 1000), { target: "boat", reason: "github-busy" });
});

const decide = async (env, { event = { pull_request: pullRequest() }, fetch = fakeFetch(busyGithub()) } = {}) => {
  const result = await route({ env, event, teamText: TEAM_TEXT, jobs: 4, fetchImpl: fetch.impl, now: NOW });
  return { ...result, calls: fetch.calls };
};

test("the kill switch, untrusted runs and re-runs go to GitHub before any request", async () => {
  for (const [env, event, reason] of [
    [prEnv({ BOAT_OVERFLOW: "off" }), undefined, "overflow-off"],
    [prEnv({ BOAT_OVERFLOW_VARS: JSON.stringify({ BOAT_OVERFLOW: "off" }) }), { pull_request: pullRequest({ labels: [{ name: FORCE_LABEL }] }) }, "overflow-off"],
    [prEnv(), { pull_request: pullRequest({ head: { repo: { full_name: "fork/ardia" } }, labels: [{ name: FORCE_LABEL }] }) }, "untrusted-fork"],
    [prEnv({ GITHUB_ACTOR: "stranger" }), undefined, "untrusted-actor"],
    [prEnv({ GITHUB_RUN_ATTEMPT: "2" }), { pull_request: pullRequest({ labels: [{ name: FORCE_LABEL }] }) }, "rerun"],
    [prEnv({ BOAT_OVERFLOW: "label" }), undefined, "overflow-label-only"],
    [prEnv({ BOAT_CI_LIMITS_KEY: "" }), undefined, "boat-key-missing"],
    [prEnv({ GITHUB_TOKEN: "" }), undefined, "github-token-missing"],
  ]) {
    const result = await decide(env, event ? { event } : {});
    assert.equal(result.target, "github", reason);
    assert.equal(result.reason, reason);
    assert.equal(result.calls.length, 0, `${reason} makes no request`);
  }
});

test("a quiet GitHub stays on GitHub without asking Boat", async () => {
  const result = await decide(prEnv(), { fetch: fakeFetch({ runs: { [CANONICAL_REPO]: { in_progress: [runOf(1)] } }, jobs: { 1: [job("in_progress", ["ubuntu-latest"])] } }) });
  assert.equal(result.target, "github");
  assert.equal(result.reason, "github-free");
  assert.ok(!result.calls.some((call) => call.url === LIMITS_URL));
});

test("a busy GitHub with Boat headroom goes to Boat, counting other runs but not this one", async () => {
  const result = await decide(prEnv());
  assert.equal(result.target, "boat");
  assert.equal(result.reason, "github-busy");
  assert.deepEqual([result.pressure.queued, result.pressure.aged], [3, 1]);
  const boatCall = result.calls.find((call) => call.url === LIMITS_URL);
  assert.equal(boatCall.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(result.calls.filter((call) => call.url !== LIMITS_URL).every((call) => call.headers.Authorization !== `Bearer ${KEY}`), "the Boat key goes to Boat only");
});

test("a push to main and a manual run on main route like a pull request", async () => {
  const base = { ...prEnv(), GITHUB_REF: MAIN_REF };
  const push = await decide({ ...base, GITHUB_EVENT_NAME: "push" }, { event: { head_commit: { author: { username: "mantrakp04" } } } });
  assert.equal(push.reason, "github-busy");
  const dispatch = await decide({ ...base, GITHUB_EVENT_NAME: "workflow_dispatch" }, { event: {} });
  assert.equal(dispatch.reason, "github-busy");
});

test("the boat-ci label skips the GitHub read but not the Boat headroom", async () => {
  const event = { pull_request: pullRequest({ labels: [{ name: FORCE_LABEL }] }) };
  const forced = await decide(prEnv(), { event, fetch: fakeFetch() });
  assert.deepEqual([forced.target, forced.reason], ["boat", "forced-label"]);
  assert.deepEqual(forced.calls.map((call) => call.url), [LIMITS_URL]);
  const labelMode = await decide(prEnv({ BOAT_OVERFLOW: "label" }), { event, fetch: fakeFetch() });
  assert.equal(labelMode.reason, "forced-label");
  const low = await decide(prEnv(), { event, fetch: fakeFetch({ boat: limits({ canStart: false }) }) });
  assert.deepEqual([low.target, low.reason], ["github", "boat-low-canstart"]);
});

test("every Boat failure falls back to GitHub", async () => {
  const cases = [
    [{ boatStatus: 401 }, "boat-api-error"],
    [{ boatStatus: 503 }, "boat-api-error"],
    [{ boat: () => Promise.reject(new Error("network down")) }, "boat-api-error"],
    [{ boat: () => ({ ok: true, status: 200, json: async () => JSON.parse("{broken") }) }, "boat-api-error"],
    [{ boat: { ok: true } }, "boat-limits-malformed"],
    [{ boat: limits({ starts: { ...limits().starts, day: { remaining: 100 } } }) }, "boat-low-day-starts"],
    [{ boat: limits({ planIncluded: { vmHoursRemaining: 3 } }) }, "boat-low-vm-hours"],
  ];
  for (const [boat, reason] of cases) {
    const result = await decide(prEnv(), { fetch: fakeFetch({ ...busyGithub(), ...boat }) });
    assert.deepEqual([result.target, result.reason], ["github", reason]);
  }
});

test("a failing GitHub read falls back to GitHub", async () => {
  const result = await decide(prEnv(), { fetch: fakeFetch({ failRepo: { [CANONICAL_REPO]: 500 } }) });
  assert.deepEqual([result.target, result.reason], ["github", "github-api-error"]);
  const thrown = await decide(prEnv(), { fetch: { impl: () => Promise.reject(new TypeError("fetch failed")), calls: [] } });
  assert.equal(thrown.reason, "github-api-error");
});

test("the report writes the outputs and a one-line table, and never the key, token or wallet", () => {
  const boat = report({ target: "boat", reason: "github-busy", pressure: { queued: 3, busy: 9, aged: 1, runs: 4, inspected: 4 }, boat: { dayStarts: 290, hourStarts: 40, minuteStarts: 9, vmHours: 400, sandboxes: 90 } }, { fallback: "ubuntu-24.04", elapsedMs: 812 });
  assert.equal(boat.outputs, `target=boat\nlarge=${BOAT_LABEL}\nreason=github-busy\n`);
  assert.match(boat.summary, /\| boat-large \| github-busy \| 812 ms \| 3 queued, 9 busy/);
  assert.match(boat.notice, /^::notice title=Runner::Long jobs run on boat-large: github-busy \(812 ms\)/);
  const github = report({ target: "github", reason: "overflow-off" }, { fallback: "ubuntu-24.04", elapsedMs: 1 });
  assert.equal(github.outputs, "target=github\nlarge=ubuntu-24.04\nreason=overflow-off\n");
  assert.match(github.summary, /GitHub.*\| not read \| not read \|/s);
  for (const text of [boat.summary, boat.notice, github.notice]) {
    assert.ok(!text.includes(KEY) && !text.includes(TOKEN) && !text.includes("123.45"));
  }
});

async function inScratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "route-runner-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function captureLog(work) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original;
  }
}

test("main writes GitHub on a decision, and GitHub with router-error when it can't read its inputs", async () => {
  await inScratch(async (dir) => {
    const output = join(dir, "output");
    const summary = join(dir, "summary");
    const team = join(dir, "TEAM.td");
    const eventPath = join(dir, "event.json");
    writeFileSync(team, TEAM_TEXT);
    writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest() }));
    const env = { ...prEnv({ BOAT_OVERFLOW: "off" }), GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    const { lines } = await captureLog(() => main(["--fallback", "ubuntu-24.04", "--jobs", "3", "--team", team], env));
    assert.equal(readFileSync(output, "utf8"), "target=github\nlarge=ubuntu-24.04\nreason=overflow-off\n");
    assert.match(readFileSync(summary, "utf8"), /overflow-off/);
    assert.ok(lines.some((line) => line.startsWith("::notice title=Runner::")));
    const broken = { ...env, BOAT_OVERFLOW: "auto", GITHUB_OUTPUT: join(dir, "broken"), GITHUB_EVENT_PATH: join(dir, "missing.json") };
    const crashed = await captureLog(() => main(["--team", team], broken));
    assert.equal(readFileSync(join(dir, "broken"), "utf8"), "target=github\nlarge=ubuntu-latest\nreason=router-error\n");
    for (const line of [...lines, ...crashed.lines]) assert.ok(!line.includes(KEY) && !line.includes(TOKEN));
  });
});

test("main prints its help and decides nothing", async () => {
  const { result, lines } = await captureLog(() => main(["--help"], {}));
  assert.equal(result, undefined);
  assert.match(lines.join("\n"), /route-runner\.mjs --fallback/);
});

const workflow = (name) => readFileSync(join(REPO, ".github/workflows", name), "utf8").replace(/\r\n/g, "\n");

function jobBlocks(text) {
  const blocks = {};
  for (const block of text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1)) blocks[block.match(/^[a-z0-9-]+/)[0]] = block;
  return blocks;
}

const ROUTED = {
  "checks.yml": { route: "changes", fallback: "ubuntu-latest", jobs: ["check", "browser"], starts: 4 },
  "linux.yml": { route: "route", fallback: "ubuntu-24.04", jobs: ["checks", "package"], starts: 3 },
  "android.yml": { route: "route", fallback: "ubuntu-latest", jobs: ["app"], starts: 1 },
};

test("each routed job picks Boat only on a first attempt whose route job succeeded and said boat", () => {
  for (const [name, { route: routeJob, fallback, jobs }] of Object.entries(ROUTED)) {
    const blocks = jobBlocks(workflow(name));
    const expected = `    runs-on: \${{ github.run_attempt == '1' && needs.${routeJob}.result == 'success' && needs.${routeJob}.outputs.target == 'boat' && '${BOAT_LABEL}' || '${fallback}' }}\n`;
    for (const jobName of jobs) {
      assert.ok(blocks[jobName].includes(expected), `${name} ${jobName} falls back to ${fallback}`);
      assert.match(blocks[jobName], new RegExp(`\\n    needs: (?:${routeJob}|\\[gate, ${routeJob}\\])\\n`), `${name} ${jobName} waits on ${routeJob}`);
    }
    for (const [jobName, block] of Object.entries(blocks)) {
      if (!jobs.includes(jobName)) assert.ok(!block.includes("boat"), `${name} ${jobName} never runs on Boat`);
    }
  }
});

test("each route job runs the router from main's code, with the key on that step only", () => {
  for (const [name, { route: routeJob, fallback, starts }] of Object.entries(ROUTED)) {
    const text = workflow(name);
    const block = jobBlocks(text)[routeJob];
    assert.equal(text.split("secrets.BOAT_CI_LIMITS_KEY").length, 2, `${name} names the key once`);
    assert.ok(block.includes("      target: ${{ steps.route.outputs.target }}\n"), `${name} exposes the target`);
    assert.match(block, /\n      actions: read\n/);
    const checkout = block.match(/- name: The router, from main\n(?: {8}.*\n)+/)[0];
    assert.ok(checkout.includes("ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || (github.ref == 'refs/heads/main' && github.sha) || 'main' }}\n"), `${name} checks out the base`);
    assert.ok(checkout.includes("persist-credentials: false\n") && checkout.includes("sparse-checkout-cone-mode: false\n") && checkout.includes("continue-on-error: true\n"));
    for (const path of ["/scripts/ci/", "/.github/TEAM.td", "/.github/vouch/vouch.cjs"]) assert.ok(checkout.includes(`            ${path}\n`), `${name} checks out ${path}`);
    const step = block.match(/- id: route\n(?: {8}.*\n?)+/)[0];
    assert.ok(step.includes("BOAT_CI_LIMITS_KEY: ${{ secrets.BOAT_CI_LIMITS_KEY }}"), `${name} gives the route step the key`);
    assert.ok(step.includes("continue-on-error: true\n"), `${name}'s route step never fails the run`);
    assert.ok(step.includes(`run: node .route/scripts/ci/route-runner.mjs --fallback ${fallback} --jobs ${starts}`), `${name} passes its fallback and Boat starts`);
  }
});

test("the route jobs of the gated workflows skip forks and leave the gate as it was", () => {
  for (const name of ["linux.yml", "android.yml"]) {
    const blocks = jobBlocks(workflow(name));
    assert.ok(blocks.route.includes("    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository\n"));
    assert.ok(blocks.route.includes("    runs-on: ubuntu-latest\n    timeout-minutes: 3\n"));
    for (const jobName of ROUTED[name].jobs) {
      assert.ok(blocks[jobName].includes("    if: ${{ !cancelled() && (needs.gate.result == 'skipped' || (needs.gate.result == 'success' && needs.gate.outputs.run == 'true')) }}\n"), `${name} ${jobName} builds exactly as before`);
    }
  }
});

test("the router's starts per run match the routed jobs", () => {
  const browser = jobBlocks(workflow("checks.yml")).browser.match(/shard: \[([^\]]+)\]/)[1].split(",").length;
  assert.equal(ROUTED["checks.yml"].starts, browser + 1);
  const shards = (jobBlocks(workflow("linux.yml")).checks.match(/\n          - \{ name:/g) || []).length;
  assert.equal(ROUTED["linux.yml"].starts, shards + 1);
});
