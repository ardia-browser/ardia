const fs = require("node:fs");
const path = require("node:path");
const vouch = require("../vouch/vouch.cjs");

const STALE = "stale";
const STALE_LABEL_SPEC = { name: STALE, color: "cfd3d7", description: "No activity for a week; closes after another quiet week" };
const PROTECTED_LABELS = [vouch.TRUSTED, vouch.DENOUNCED, vouch.READY, "pinned", "keep-open"];
const TARGET_LABELS = [vouch.UNVOUCHED, vouch.INCOMPLETE, vouch.NEEDS_REBASE];
const WARNED_MARKER = "<!-- ardia-stale:warned -->";
const CLOSED_MARKER = "<!-- ardia-stale:closed -->";
const NUDGE_AFTER_DAYS = 7;
const CLOSE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNEXPLAINED_UPDATE_SLACK_MS = 60 * 1000;
const MAX_PRS_PER_RUN = 40;
const TEAM_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
const WORKFLOW_BOT = "github-actions[bot]";
const ACTIVITY_EVENTS = new Set([
  "commented",
  "committed",
  "reviewed",
  "line-commented",
  "head_ref_force_pushed",
  "head_ref_restored",
  "reopened",
  "ready_for_review",
  "convert_to_draft",
  "renamed",
]);
const SWEEP_WRITE_INTERVAL_MS = 1500;
const TEAM_LIST_PATH = ".github/TEAM.td";
const VOUCHED_LIST_PATH = ".github/VOUCHED.td";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

class RateLimited extends Error {}

function labelNames(item) {
  return (item.labels || []).map((label) => (typeof label === "string" ? label : label.name));
}

function isBot(actor) {
  if (!actor) return false;
  return actor.type === "Bot" || String(actor.login || "").endsWith("[bot]");
}

function sameLogin(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function parseTeam(text) {
  return new Set(
    [...vouch.parseVouchedList(text || "")].filter(([, entry]) => !entry.denounced).map(([login]) => login),
  );
}

function isTeamAuthor(pr, team) {
  const author = pr.user;
  if (!author || isBot(author)) return true;
  if (team.has(String(author.login).toLowerCase())) return true;
  return TEAM_ASSOCIATIONS.includes(pr.author_association);
}

function isProtected(pr, team) {
  if (labelNames(pr).some((label) => PROTECTED_LABELS.includes(label))) return true;
  return isTeamAuthor(pr, team);
}

function isEligible(pr, team) {
  if (pr.state !== "open" || isProtected(pr, team)) return false;
  return labelNames(pr).some((label) => TARGET_LABELS.includes(label));
}

function eventTime(event) {
  if (event.event === "committed") {
    return Date.parse((event.committer && event.committer.date) || (event.author && event.author.date) || "");
  }
  if (event.event === "reviewed") return Date.parse(event.submitted_at || "");
  return Date.parse(event.created_at || "");
}

function eventActor(event) {
  return event.actor || event.user || null;
}

function isActivity(event) {
  if (event.event === "unlabeled") return Boolean(event.label && event.label.name === STALE);
  if (!ACTIVITY_EVENTS.has(event.event)) return false;
  if (event.event === "committed") return true;
  return !isBot(eventActor(event));
}

function latestTime(times, floor = null) {
  return times.filter(Number.isFinite).reduce((latest, time) => (latest === null ? time : Math.max(latest, time)), floor);
}

function unexplainedUpdate(pr, events) {
  const updated = Date.parse(pr.updated_at || "");
  if (!Number.isFinite(updated)) return null;
  const explained = latestTime(events.map(eventTime), Date.parse(pr.created_at || "") || 0);
  return updated > explained + UNEXPLAINED_UPDATE_SLACK_MS ? updated : null;
}

function lastActivity(pr, events) {
  const times = events.filter(isActivity).map(eventTime);
  times.push(unexplainedUpdate(pr, events));
  return latestTime(times, Date.parse(pr.created_at || "") || 0);
}

function botMarkerTimes(events, marker) {
  return events
    .filter((event) => event.event === "commented" && sameLogin((eventActor(event) || {}).login, WORKFLOW_BOT))
    .filter((event) => String(event.body || "").includes(marker))
    .map(eventTime)
    .filter(Number.isFinite);
}

function warnedAt(events) {
  return latestTime(botMarkerTimes(events, WARNED_MARKER));
}

function timelineProtected(events) {
  const active = new Set();
  for (const event of events) {
    const name = event.label && event.label.name;
    if (!name || !PROTECTED_LABELS.includes(name)) continue;
    if (event.event === "labeled") active.add(name);
    else if (event.event === "unlabeled") active.delete(name);
  }
  return active.size > 0;
}

function decide({ pr, events, now, team }) {
  if (isProtected(pr, team) || timelineProtected(events)) return { action: "skip" };
  const marked = labelNames(pr).includes(STALE);
  if (!isEligible(pr, team)) return { action: marked ? "unstale" : "skip" };
  const active = lastActivity(pr, events);
  const warned = warnedAt(events);
  if (warned !== null && active <= warned) {
    return { action: now - warned >= CLOSE_AFTER_DAYS * DAY_MS ? "close" : "wait", warned };
  }
  if (marked && warned !== null) return { action: "unstale" };
  return { action: now - active >= NUDGE_AFTER_DAYS * DAY_MS ? "nudge" : "wait" };
}

function needsOf(pr) {
  const labels = labelNames(pr);
  const base = (pr.base && pr.base.ref) || "main";
  const needs = [];
  if (labels.includes(vouch.NEEDS_REBASE)) needs.push(`it conflicts with \`${base}\`, so it needs a rebase`);
  if (labels.includes(vouch.INCOMPLETE)) {
    needs.push("something in CONTRIBUTING.md is still missing (a screenshot or video, an open bot thread answered, or a passing check)");
  }
  if (!needs.length) needs.push("it is still waiting on an update from you");
  return needs.join(", and ");
}

function authorOf(pr) {
  return pr.user ? pr.user.login : "there";
}

function nudgeBody(pr) {
  return [
    `Hi @${authorOf(pr)}, this pull request has had no activity for ${NUDGE_AFTER_DAYS} days, and ${needsOf(pr)}.`,
    `Push an update or leave a comment to keep it open; otherwise it closes in ${CLOSE_AFTER_DAYS} days.`,
    WARNED_MARKER,
  ].join("\n");
}

function closeBody(pr) {
  return [
    `Closing this for now, @${authorOf(pr)}: it has had no activity for ${NUDGE_AFTER_DAYS + CLOSE_AFTER_DAYS} days, and ${needsOf(pr)}.`,
    "Thanks for the work! Once it is rebased or updated, comment here and it reopens, or open a new pull request.",
    CLOSED_MARKER,
  ].join("\n");
}

function readRepoFile(relative, root = REPO_ROOT) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ignoreStatus(...statuses) {
  return (error) => {
    if (!statuses.includes(error.status)) throw error;
    return null;
  };
}

function isRateLimit(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  if (error.status !== 403) return false;
  const headers = (error.response && error.response.headers) || {};
  return /rate limit/i.test(String(error.message || "")) || headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined;
}

function runLimit(context, limit) {
  const asked = Number((context.payload && context.payload.inputs && context.payload.inputs.max_prs) || limit || MAX_PRS_PER_RUN);
  return Number.isInteger(asked) && asked > 0 ? asked : MAX_PRS_PER_RUN;
}

function createSession({ github, context, core, team, vouched, now, pace, limit }) {
  return {
    github,
    context,
    core,
    repo: { owner: context.repo.owner, repo: context.repo.repo },
    team: parseTeam(team === undefined ? readRepoFile(TEAM_LIST_PATH) : team),
    vouched: vouch.parseVouchedList(vouched === undefined ? readRepoFile(VOUCHED_LIST_PATH) : vouched),
    now: now || (() => Date.now()),
    pace: pace || (() => sleep(SWEEP_WRITE_INTERVAL_MS)),
    limit: runLimit(context, limit),
    wrote: false,
    labelReady: false,
  };
}

function asRateLimited(error) {
  return isRateLimit(error) ? new RateLimited(error.message || "rate limited") : error;
}

async function read(request) {
  try {
    return await request();
  } catch (error) {
    throw asRateLimited(error);
  }
}

async function write(session, request, { paced = true } = {}) {
  if (paced && session.wrote) await session.pace();
  session.wrote = true;
  try {
    return await request();
  } catch (error) {
    throw asRateLimited(error);
  }
}

async function ensureLabel(session) {
  if (session.labelReady) return;
  await write(session, () => session.github.rest.issues.createLabel({ ...session.repo, ...STALE_LABEL_SPEC }).catch(ignoreStatus(422)));
  session.labelReady = true;
}

async function addStale(session, pr) {
  if (labelNames(pr).includes(STALE)) return;
  await ensureLabel(session);
  await write(session, () => session.github.rest.issues.addLabels({ ...session.repo, issue_number: pr.number, labels: [STALE] }));
}

function removeStale(session, number) {
  return write(session, () =>
    session.github.rest.issues.removeLabel({ ...session.repo, issue_number: number, name: STALE }).catch(ignoreStatus(404)),
  );
}

function timelineOf(session, number) {
  return read(() =>
    session.github.paginate(session.github.rest.issues.listEventsForTimeline, {
      ...session.repo,
      issue_number: number,
      per_page: 100,
    }),
  );
}

async function livePull(session, number) {
  return (await read(() => session.github.rest.pulls.get({ ...session.repo, pull_number: number }))).data;
}

async function act(session, pr, events, decision) {
  const { github, repo } = session;
  const issue_number = pr.number;
  if (decision.action === "nudge") {
    await ensureLabel(session);
    await write(session, () => github.rest.issues.createComment({ ...repo, issue_number, body: nudgeBody(pr) }));
    await addStale(session, pr);
    return "done";
  }
  if (decision.action === "close") {
    await addStale(session, pr);
    const closeNoted = botMarkerTimes(events, CLOSED_MARKER).some((time) => time >= decision.warned);
    if (!closeNoted) {
      await write(session, () => github.rest.issues.createComment({ ...repo, issue_number, body: closeBody(pr) }));
    }
    if (session.wrote) await session.pace();
    const liveEvents = await timelineOf(session, issue_number);
    const live = await livePull(session, issue_number);
    const recheck = decide({ pr: live, events: liveEvents, now: session.now(), team: session.team });
    if (recheck.action !== "close" || !labelNames(live).includes(STALE)) return "held";
    await write(session, () => github.rest.pulls.update({ ...repo, pull_number: issue_number, state: "closed" }), { paced: false });
    return "done";
  }
  if (decision.action === "unstale") await removeStale(session, issue_number);
  return "done";
}

function mayWaitWithoutTimeline(pr, now) {
  if (labelNames(pr).includes(STALE)) return false;
  const updated = Date.parse(pr.updated_at || "");
  return Number.isFinite(updated) && now - updated < NUDGE_AFTER_DAYS * DAY_MS;
}

const ACTIONS = ["nudge", "close", "unstale"];

async function planFor(session, pr, now) {
  const events = isEligible(pr, session.team) ? await timelineOf(session, pr.number) : [];
  return { events, decision: decide({ pr, events, now, team: session.team }) };
}

async function sweepPulls(session, dryRun, report) {
  const { github, repo, core } = session;
  const now = session.now();
  const pulls = await read(() => github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 }));
  let handled = 0;
  for (const listed of pulls) {
    if (isProtected(listed, session.team)) continue;
    if (!labelNames(listed).includes(STALE) && !isEligible(listed, session.team)) continue;
    if (mayWaitWithoutTimeline(listed, now)) continue;
    report.at = listed.number;
    const planned = await planFor(session, listed, now);
    if (!ACTIONS.includes(planned.decision.action)) continue;
    if (handled >= session.limit) {
      report.deferred.push(listed.number);
      continue;
    }
    handled += 1;
    let pr = listed;
    let { events, decision } = planned;
    if (!dryRun) {
      pr = await livePull(session, listed.number);
      ({ events, decision } = await planFor(session, pr, session.now()));
      if (decision.action !== planned.decision.action) {
        core.info(`#${pr.number} changed during the sweep: ${planned.decision.action} is now ${decision.action}`);
        report.changed.push(pr.number);
        if (!ACTIONS.includes(decision.action)) continue;
      }
    }
    core.info(`${dryRun ? "Would" : "Will"} ${decision.action} #${pr.number}`);
    if (dryRun) {
      report[decision.action].push(pr.number);
      continue;
    }
    if ((await act(session, pr, events, decision)) === "held") {
      core.info(`#${pr.number} became protected or active before it closed; left open`);
      report.changed.push(pr.number);
      continue;
    }
    report[decision.action].push(pr.number);
  }
}

async function sweep(session, dryRun) {
  const { core } = session;
  const report = { nudge: [], close: [], unstale: [], deferred: [], changed: [], stopped: null, at: null };
  try {
    await sweepPulls(session, dryRun, report);
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    report.stopped = `rate limited${report.at === null ? " listing pull requests" : ` at #${report.at}`}: ${error.message}`;
    core.warning(`Stopping the sweep, ${report.stopped}`);
  }
  delete report.at;
  const lines = ["nudge", "close", "unstale", "deferred", "changed"].map(
    (key) => `- ${key}: ${report[key].length ? report[key].map((n) => `#${n}`).join(", ") : "none"}`,
  );
  if (report.stopped) lines.push(`- stopped: ${report.stopped}`);
  if (core.summary) {
    await core.summary.addRaw(`## Stale pull requests${dryRun ? " (dry run)" : ""}\n\n${lines.join("\n")}\n`).write();
  }
  return report;
}

async function clearIfStillStale(session, number) {
  const live = await livePull(session, number);
  if (!live || live.state !== "open" || isProtected(live, session.team) || !labelNames(live).includes(STALE)) return null;
  await removeStale(session, number);
  return "unstale";
}

async function onPullUpdate(session) {
  const pr = session.context.payload.pull_request;
  if (!pr || pr.state !== "open" || isBot(session.context.payload.sender)) return null;
  if (isProtected(pr, session.team) || !labelNames(pr).includes(STALE)) return null;
  return clearIfStillStale(session, pr.number);
}

function isWorkflowBot(actor) {
  return sameLogin((actor || {}).login, WORKFLOW_BOT);
}

function isSweepNote(event, marker) {
  return event.event === "commented" && isWorkflowBot(eventActor(event)) && String(event.body || "").includes(marker);
}

function interruptsClose(event) {
  if (event.event === "reopened" || event.event === "closed") return true;
  if (event.event !== "commented" || !isWorkflowBot(eventActor(event))) return false;
  return !isSweepNote(event, CLOSED_MARKER) && !isSweepNote(event, WARNED_MARKER);
}

function closedBySweep(events) {
  const closeIndex = events.map((event) => event.event).lastIndexOf("closed");
  if (closeIndex === -1 || !isWorkflowBot(eventActor(events[closeIndex]))) return false;
  let noteIndex = closeIndex - 1;
  while (noteIndex >= 0 && !isSweepNote(events[noteIndex], CLOSED_MARKER)) noteIndex -= 1;
  if (noteIndex < 0) return false;
  return !events.slice(noteIndex + 1, closeIndex).some(interruptsClose);
}

async function onComment(session) {
  const { github, repo, core, context } = session;
  const { issue, comment } = context.payload;
  if (!issue || !issue.pull_request || !comment || isBot(comment.user)) return null;
  if (isProtected(issue, session.team) || !labelNames(issue).includes(STALE)) return null;
  if (issue.state === "open") return clearIfStillStale(session, issue.number);
  if (issue.pull_request.merged_at) return null;
  if (!issue.user || !sameLogin(comment.user.login, issue.user.login)) return null;
  if (vouch.listStatus(session.vouched, issue.user.login) === "denounced") return null;
  if (!closedBySweep(await timelineOf(session, issue.number))) return null;
  const live = await livePull(session, issue.number);
  if (!live || live.state !== "closed" || live.merged_at || isProtected(live, session.team)) return null;
  try {
    await write(session, () => github.rest.pulls.update({ ...repo, pull_number: issue.number, state: "open" }));
  } catch (error) {
    if (error.status !== 422) throw error;
    core.warning(`#${issue.number} could not be reopened: ${error.message}`);
    await write(session, () =>
      github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body: `@${issue.user.login}, this pull request can't be reopened as it is (its branch may be gone). Please open a new pull request.`,
      }),
    );
    return "unreopenable";
  }
  await removeStale(session, issue.number);
  return "reopen";
}

async function run(args) {
  const session = createSession(args);
  const { context } = session;
  if (context.eventName === "pull_request_target") return onPullUpdate(session);
  if (context.eventName === "issue_comment") return onComment(session);
  const dryRun = context.eventName === "workflow_dispatch" && String((context.payload.inputs || {}).dry_run) === "true";
  return sweep(session, dryRun);
}

module.exports = {
  STALE,
  PROTECTED_LABELS,
  TARGET_LABELS,
  WARNED_MARKER,
  CLOSED_MARKER,
  NUDGE_AFTER_DAYS,
  CLOSE_AFTER_DAYS,
  MAX_PRS_PER_RUN,
  parseTeam,
  isProtected,
  isEligible,
  isActivity,
  lastActivity,
  warnedAt,
  decide,
  needsOf,
  nudgeBody,
  closeBody,
  isRateLimit,
  run,
};
