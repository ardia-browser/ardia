#!/usr/bin/env node
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Picks the runner for this workflow run's long jobs: GitHub-hosted, or Boat CI when GitHub's
runners are busy, the run is trusted and the Boat account has headroom. Writes target=github|boat,
large=<runner label> and reason=<why> to $GITHUB_OUTPUT, and the decision to the step summary.
Every error, timeout or missing field picks GitHub. docs/ci-boat-overflow.md has the rules.

  scripts/ci/route-runner.mjs --fallback <GitHub label> --jobs <Boat jobs this run starts> [--team <TEAM.td>]

Reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_ACTOR,
GITHUB_TRIGGERING_ACTOR, GITHUB_RUN_ATTEMPT, GITHUB_RUN_ID, GITHUB_TOKEN, BOAT_CI_LIMITS_KEY,
and the BOAT_OVERFLOW* settings from the environment or from BOAT_OVERFLOW_VARS (toJSON(vars)).`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const { parseVouchedList } = createRequire(import.meta.url)("../../.github/vouch/vouch.cjs");

export const CANONICAL_REPO = "ardia-browser/ardia";
export const MAIN_BRANCH = "main";
export const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
export const FORCE_LABEL = "boat-ci";
export const BOAT_LABEL = "boat-large";
export const BOAT_MACHINE = "large";
export const LIMITS_URL = "https://boat.dev/api/v1/limits";
export const GITHUB_API = "https://api.github.com";
export const REQUEST_TIMEOUT_MS = 5000;
export const ROUTE_DEADLINE_MS = 25000;

export const DEFAULTS = {
  mode: "auto",
  repos: [CANONICAL_REPO, "ardia-browser/plugins"],
  queued: 3,
  busy: 36,
  queuedAge: 20,
  dayStarts: 120,
  hourStarts: 20,
  minuteStarts: 5,
  vmHours: 50,
  sandboxes: 5,
  maxRequests: 30,
};

const NUMBER_SETTINGS = {
  queued: "BOAT_OVERFLOW_QUEUED",
  busy: "BOAT_OVERFLOW_BUSY",
  queuedAge: "BOAT_OVERFLOW_QUEUED_AGE",
  dayStarts: "BOAT_OVERFLOW_DAY_STARTS",
  hourStarts: "BOAT_OVERFLOW_HOUR_STARTS",
  minuteStarts: "BOAT_OVERFLOW_MINUTE_STARTS",
  vmHours: "BOAT_OVERFLOW_VM_HOURS",
  sandboxes: "BOAT_OVERFLOW_SANDBOXES",
};

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${new URL(url).host}${new URL(url).pathname}`);
    this.status = status;
  }
}

function varsFrom(env) {
  try {
    const parsed = JSON.parse(env.BOAT_OVERFLOW_VARS || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function count(text, fallback) {
  const trimmed = String(text ?? "").trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}

export function settingsFrom(env) {
  const merged = { ...varsFrom(env) };
  for (const [key, value] of Object.entries(env)) if (key.startsWith("BOAT_OVERFLOW") && value !== "") merged[key] = value;
  const modeText = String(merged.BOAT_OVERFLOW ?? "").trim().toLowerCase();
  const mode = modeText === "off" ? "off" : modeText === "label" ? "label" : "auto";
  const repos = String(merged.BOAT_OVERFLOW_REPOS ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo));
  const settings = { ...DEFAULTS, mode, repos: repos.length ? repos : DEFAULTS.repos };
  for (const [name, key] of Object.entries(NUMBER_SETTINGS)) settings[name] = count(merged[key], DEFAULTS[name]);
  return settings;
}

export function teamFrom(text) {
  return new Set([...parseVouchedList(text || "")].filter(([, entry]) => !entry.denounced).map(([login]) => login));
}

const onTeam = (team, login) => typeof login === "string" && login !== "" && team.has(login.toLowerCase());

export function trustOf({ eventName, repository, ref, actor, triggeringActor, event }, team) {
  if (repository !== CANONICAL_REPO) return { trusted: false, reason: "untrusted-repo" };
  const actors = [actor, triggeringActor];
  if (eventName === "pull_request") {
    const pr = event?.pull_request;
    if (!pr || pr.base?.repo?.full_name !== repository) return { trusted: false, reason: "untrusted-repo" };
    if (pr.head?.repo?.full_name !== repository) return { trusted: false, reason: "untrusted-fork" };
    if (pr.base?.ref !== MAIN_BRANCH) return { trusted: false, reason: "untrusted-base" };
    actors.push(pr.user?.login);
  } else if (eventName === "push" || eventName === "workflow_dispatch") {
    if (ref !== MAIN_REF) return { trusted: false, reason: "untrusted-ref" };
    if (eventName === "push") actors.push(event?.head_commit?.author?.username);
  } else {
    return { trusted: false, reason: "untrusted-event" };
  }
  if (!actors.every((login) => onTeam(team, login))) return { trusted: false, reason: "untrusted-actor" };
  return { trusted: true, reason: "trusted" };
}

export function forcedByLabel({ eventName, event }) {
  if (eventName !== "pull_request") return false;
  const labels = event?.pull_request?.labels;
  return Array.isArray(labels) && labels.some((label) => label?.name === FORCE_LABEL);
}

const LARGER_RUNNER = /-(?:large|xlarge)$/;

export function runnerKind(labels) {
  if (!Array.isArray(labels) || labels.length !== 1 || typeof labels[0] !== "string") return null;
  const label = labels[0].toLowerCase();
  if (LARGER_RUNNER.test(label)) return null;
  const found = /^(ubuntu|windows|macos)-[\w.]+(?:-arm)?$/.exec(label);
  return found ? found[1] : null;
}

export function pressureOf(jobs, { now, queuedAge }) {
  const pressure = { queued: 0, busy: 0, aged: 0 };
  for (const job of jobs) {
    const kind = runnerKind(job?.labels);
    if (!kind || (job.status !== "queued" && job.status !== "in_progress")) continue;
    pressure.busy += 1;
    if (job.status !== "queued" || kind === "macos") continue;
    pressure.queued += 1;
    const created = Date.parse(job.created_at);
    if (queuedAge > 0 && Number.isFinite(created) && now - created >= queuedAge * 1000) pressure.aged += 1;
  }
  return pressure;
}

export function overflowOf(pressure, settings) {
  if (pressure.queued >= settings.queued) return true;
  if (pressure.busy >= settings.busy) return true;
  return settings.queuedAge > 0 && pressure.aged > 0;
}

const isCount = (value) => typeof value === "number" && Number.isFinite(value);

export function headroomOf(limits, { jobs, settings, machine = BOAT_MACHINE }) {
  const starts = limits?.starts;
  const windows = ["day", "hour", "minute"];
  const startsKnown = starts?.unlimited === true || windows.every((window) => isCount(starts?.[window]?.remaining));
  if (
    !limits ||
    typeof limits.canStart !== "boolean" ||
    !startsKnown ||
    !isCount(limits.planIncluded?.vmHoursRemaining) ||
    !isCount(limits.activeSandboxes) ||
    !isCount(limits.maxActiveSandboxes) ||
    !Array.isArray(limits.machineTypes)
  ) {
    return { ok: false, reason: "boat-limits-malformed" };
  }
  if (!limits.canStart) return { ok: false, reason: "boat-low-canstart" };
  if (!limits.machineTypes.some((type) => type?.type === machine && type.available === true)) return { ok: false, reason: "boat-low-machine" };
  if (starts.unlimited !== true) {
    const reserves = { day: settings.dayStarts, hour: settings.hourStarts, minute: settings.minuteStarts };
    for (const window of windows) {
      if (starts[window].remaining - jobs < reserves[window]) return { ok: false, reason: `boat-low-${window}-starts` };
    }
  }
  if (limits.planIncluded.vmHoursRemaining < settings.vmHours) return { ok: false, reason: "boat-low-vm-hours" };
  if (limits.maxActiveSandboxes - limits.activeSandboxes - jobs < settings.sandboxes) return { ok: false, reason: "boat-low-sandboxes" };
  return { ok: true, reason: "boat-ok" };
}

export function headroomFacts(limits) {
  const starts = limits?.starts;
  const left = (window) => (starts?.unlimited === true ? "unlimited" : starts?.[window]?.remaining);
  return {
    dayStarts: left("day"),
    hourStarts: left("hour"),
    minuteStarts: left("minute"),
    vmHours: limits?.planIncluded?.vmHoursRemaining,
    sandboxes: isCount(limits?.maxActiveSandboxes) && isCount(limits?.activeSandboxes) ? limits.maxActiveSandboxes - limits.activeSandboxes : undefined,
  };
}

export function makeFetchJson(fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return async (url, headers = {}) => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new HttpError(response.status, url);
    return response.json();
  };
}

function githubHeaders(token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ardia-route-runner" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function githubPressure({ fetchJson, token, settings, ownRepo, ownRunId, now }) {
  let budget = settings.maxRequests;
  const errors = [];
  const anonymous = new Set();
  const get = async (repo, path) => {
    budget -= 1;
    const url = `${GITHUB_API}/repos/${repo}${path}`;
    if (anonymous.has(repo)) return fetchJson(url, githubHeaders(null));
    try {
      return await fetchJson(url, githubHeaders(token));
    } catch (error) {
      if (repo === ownRepo || !(error instanceof HttpError) || (error.status !== 403 && error.status !== 404) || budget <= 0) throw error;
      anonymous.add(repo);
      budget -= 1;
      return fetchJson(url, githubHeaders(null));
    }
  };
  const runs = new Map();
  for (const repo of settings.repos) {
    for (const status of ["queued", "in_progress"]) {
      for (let page = 1; budget > 0; page += 1) {
        let data;
        try {
          data = await get(repo, `/actions/runs?status=${status}&per_page=100&page=${page}`);
        } catch (error) {
          if (repo === ownRepo) throw error;
          errors.push(`${repo}: ${error.message}`);
          break;
        }
        if (!Array.isArray(data?.workflow_runs)) {
          if (repo === ownRepo) throw new Error(`malformed runs list from ${repo}`);
          errors.push(`${repo}: malformed runs list`);
          break;
        }
        for (const run of data.workflow_runs) {
          if (repo === ownRepo && String(run.id) === String(ownRunId)) continue;
          runs.set(`${repo}#${run.id}`, { repo, id: run.id, created: Date.parse(run.created_at) || 0 });
        }
        if (data.workflow_runs.length < 100) break;
      }
    }
  }
  const newest = [...runs.values()].sort((a, b) => b.created - a.created);
  const inspected = newest.slice(0, Math.max(0, budget));
  const jobLists = await Promise.all(
    inspected.map((run) =>
      get(run.repo, `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).then(
        (data) => (Array.isArray(data?.jobs) ? data.jobs : []),
        (error) => {
          errors.push(`${run.repo} run ${run.id}: ${error.message}`);
          return [];
        },
      ),
    ),
  );
  return {
    ...pressureOf(jobLists.flat(), { now, queuedAge: settings.queuedAge }),
    runs: runs.size,
    inspected: inspected.length,
    errors,
  };
}

const decision = (target, reason, facts = {}) => ({ target, reason, ...facts });

export async function route({ env, event, teamText, jobs, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const settings = settingsFrom(env);
  if (settings.mode === "off") return decision("github", "overflow-off");
  const context = {
    eventName: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR,
    event,
  };
  const trust = trustOf(context, teamFrom(teamText));
  if (!trust.trusted) return decision("github", trust.reason);
  if (String(env.GITHUB_RUN_ATTEMPT || "1") !== "1") return decision("github", "rerun");
  const forced = forcedByLabel(context);
  if (settings.mode === "label" && !forced) return decision("github", "overflow-label-only");
  if (!env.BOAT_CI_LIMITS_KEY) return decision("github", "boat-key-missing");
  const fetchJson = makeFetchJson(fetchImpl);
  let pressure;
  if (!forced) {
    if (!env.GITHUB_TOKEN) return decision("github", "github-token-missing");
    try {
      pressure = await githubPressure({ fetchJson, token: env.GITHUB_TOKEN, settings, ownRepo: context.repository, ownRunId: env.GITHUB_RUN_ID, now });
    } catch {
      return decision("github", "github-api-error");
    }
    if (!overflowOf(pressure, settings)) return decision("github", "github-free", { pressure });
  }
  let limits;
  try {
    limits = await fetchJson(LIMITS_URL, { Authorization: `Bearer ${env.BOAT_CI_LIMITS_KEY}`, Accept: "application/json", "User-Agent": "ardia-route-runner" });
  } catch {
    return decision("github", "boat-api-error", { pressure });
  }
  const headroom = headroomOf(limits, { jobs, settings });
  const boat = headroomFacts(limits);
  if (!headroom.ok) return decision("github", headroom.reason, { pressure, boat });
  return decision("boat", forced ? "forced-label" : "github-busy", { pressure, boat });
}

export function withDeadline(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(decision("github", "router-timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const show = (value) => (value === undefined || value === null ? "?" : String(value));

export function report(result, { fallback, elapsedMs }) {
  const label = result.target === "boat" ? BOAT_LABEL : fallback;
  const pressure = result.pressure
    ? `GitHub: ${result.pressure.queued} queued, ${result.pressure.busy} busy, ${result.pressure.aged} waiting ≥ age limit, ${result.pressure.inspected} of ${result.pressure.runs} runs read`
    : "GitHub: not read";
  const boat = result.boat
    ? `Boat: starts left ${show(result.boat.dayStarts)}/day ${show(result.boat.hourStarts)}/hour ${show(result.boat.minuteStarts)}/minute, ${show(result.boat.vmHours)} VM hours, ${show(result.boat.sandboxes)} sandboxes free`
    : "Boat: not read";
  const outputs = `target=${result.target}\nlarge=${label}\nreason=${result.reason}\n`;
  const summary = [
    `### Long jobs run on \`${label}\` (${result.reason})`,
    "",
    "| Runner | Reason | Probe | GitHub | Boat |",
    "| - | - | - | - | - |",
    `| ${label} | ${result.reason} | ${elapsedMs} ms | ${pressure.replace(/^GitHub: /, "")} | ${boat.replace(/^Boat: /, "")} |`,
    "",
  ].join("\n");
  const notice = `::notice title=Runner::Long jobs run on ${label}: ${result.reason} (${elapsedMs} ms). ${pressure}. ${boat}.`;
  return { outputs, summary, notice, label };
}

function argsFrom(argv) {
  const args = { fallback: "ubuntu-latest", jobs: 1, team: join(SCRIPT_DIR, "../../.github/TEAM.td") };
  for (let at = 0; at < argv.length; at++) {
    const [flag, value] = [argv[at], argv[at + 1]];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--fallback" && value) (args.fallback = value), at++;
    else if (flag === "--jobs" && value) (args.jobs = Math.max(1, count(value, 1))), at++;
    else if (flag === "--team" && value) (args.team = value), at++;
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = argsFrom(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  const started = Date.now();
  let result;
  try {
    const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
    const teamText = readFileSync(args.team, "utf8");
    result = await withDeadline(route({ env, event, teamText, jobs: args.jobs }), ROUTE_DEADLINE_MS);
  } catch (error) {
    console.log(`router error: ${error?.message ?? error}`);
    result = decision("github", "router-error");
  }
  for (const problem of result.pressure?.errors ?? []) console.log(`GitHub read skipped: ${problem}`);
  const { outputs, summary, notice } = report(result, { fallback: args.fallback, elapsedMs: Date.now() - started });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(notice);
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.log(`router error: ${error?.message ?? error}`);
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, "target=github\nreason=router-error\n");
      } catch {}
    }
  });
  process.exitCode = 0;
}
