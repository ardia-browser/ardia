const test = require("node:test");
const assert = require("node:assert/strict");
const stale = require("./stale.cjs");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const TEAM = "shivamhwp\nmantrakp04\n";
const VOUCHED = "friend\n-spammer spam and abuse\n";
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" };

function ago(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function pr(number, login, { labels = [], association = "CONTRIBUTOR", created = ago(30), updated, state = "open" } = {}) {
  return {
    number,
    state,
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    author_association: association,
    labels: labels.map((name) => ({ name })),
    base: { ref: "main" },
    created_at: created,
    updated_at: updated === undefined ? created : updated,
  };
}

const human = (login) => ({ login, type: "User" });
const bot = (login) => ({ login, type: "Bot" });
const commented = (days, actor, body = "hi") => ({ event: "commented", created_at: ago(days), actor, user: actor, body });
const warned = (days) => commented(days, ACTIONS_BOT, `note\n${stale.WARNED_MARKER}`);
const closeNote = (days) => commented(days, ACTIONS_BOT, `closing\n${stale.CLOSED_MARKER}`);
const closed = (days, actor = ACTIONS_BOT) => ({ event: "closed", created_at: ago(days), actor });
const labeled = (days, name, actor = ACTIONS_BOT) => ({ event: "labeled", created_at: ago(days), label: { name }, actor });
const unlabeled = (days, name, actor = ACTIONS_BOT) => ({ event: "unlabeled", created_at: ago(days), label: { name }, actor });
const committed = (days) => ({ event: "committed", committer: { date: ago(days) }, author: { date: ago(days) } });

function fakeGithub({ pulls = [], current = {}, timelines = {}, issues = {}, failOn = null } = {}) {
  const calls = [];
  const reads = {};
  const check = (name, params) => {
    if (!failOn) return;
    const error = failOn(name, params, calls.filter((call) => !READS.has(call.name)).length);
    if (error) throw error;
  };
  const count = (key) => {
    reads[key] = (reads[key] || 0) + 1;
    return reads[key];
  };
  const record = (name) => async (params) => {
    calls.push({ name, params });
    check(name, params);
    return { data: {} };
  };
  return {
    calls,
    paginate: async (method, params) => {
      calls.push({ name: method.endpointName, params });
      check(method.endpointName, params);
      if (method.endpointName === "pulls.list") return pulls;
      const number = params.issue_number;
      const timeline = timelines[number];
      const read = count(`timeline${number}`);
      return typeof timeline === "function" ? timeline(read) : timeline || [];
    },
    rest: {
      pulls: {
        list: Object.assign(async () => ({ data: pulls }), { endpointName: "pulls.list" }),
        get: async (params) => {
          calls.push({ name: "pulls.get", params });
          check("pulls.get", params);
          const live = current[params.pull_number];
          const read = count(`pull${params.pull_number}`);
          const data = typeof live === "function" ? live(read) : live;
          return { data: data || pulls.find((item) => item.number === params.pull_number) };
        },
        update: record("pulls.update"),
      },
      issues: {
        listEventsForTimeline: Object.assign(async () => ({ data: [] }), { endpointName: "issues.listEventsForTimeline" }),
        createLabel: record("issues.createLabel"),
        createComment: record("issues.createComment"),
        addLabels: record("issues.addLabels"),
        removeLabel: record("issues.removeLabel"),
        get: async (params) => {
          calls.push({ name: "issues.get", params });
          return { data: issues[params.issue_number] || {} };
        },
      },
    },
  };
}

const READS = new Set(["pulls.list", "pulls.get", "issues.listEventsForTimeline", "issues.get"]);

function fakeCore() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(line),
    warning: (line) => lines.push(`warning: ${line}`),
    summary: { addRaw(text) { lines.push(text); return this; }, write: async () => {} },
  };
}

function context(eventName, payload = {}) {
  return { eventName, payload, repo: { owner: "ardia-browser", repo: "ardia" } };
}

function writes(github) {
  return github.calls.filter((call) => !READS.has(call.name));
}

async function runWith(github, eventName, payload, options = {}) {
  let paced = 0;
  const result = await stale.run({
    github,
    context: context(eventName, payload),
    core: options.core || fakeCore(),
    team: TEAM,
    vouched: VOUCHED,
    now: () => NOW,
    pace: async () => {
      paced += 1;
      if (options.pace) await options.pace();
    },
    limit: options.limit,
  });
  if (options.onPaced) options.onPaced(paced);
  return result;
}

const team = stale.parseTeam(TEAM);

test("only outside pull requests with a target label and no protection are eligible", () => {
  assert.equal(stale.isEligible(pr(1, "outsider", { labels: ["incomplete"] }), team), true);
  assert.equal(stale.isEligible(pr(2, "outsider", { labels: ["needs-rebase"] }), team), true);
  assert.equal(stale.isEligible(pr(3, "outsider", { labels: ["vouch:unvouched"] }), team), true);
  assert.equal(stale.isEligible(pr(4, "outsider", { labels: [] }), team), false);
  for (const keep of ["ready", "pinned", "keep-open", "vouch:trusted", "vouch:denounced"]) {
    assert.equal(stale.isProtected(pr(5, "outsider", { labels: ["incomplete", keep] }), team), true, keep);
    assert.equal(stale.isEligible(pr(5, "outsider", { labels: ["incomplete", keep] }), team), false, keep);
  }
  assert.equal(stale.isProtected(pr(6, "MantraKP04", { labels: ["incomplete"] }), team), true);
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(stale.isProtected(pr(7, "someone", { labels: ["incomplete"], association }), team), true, association);
  }
  assert.equal(stale.isProtected(pr(8, "dependabot[bot]", { labels: ["incomplete"] }), team), true);
  assert.equal(stale.isEligible(pr(9, "outsider", { labels: ["incomplete"], state: "closed" }), team), false);
});

test("bot comments and label changes are not activity; people, pushes and stale removals are", () => {
  const item = pr(1, "outsider", { created: ago(30) });
  assert.equal(stale.lastActivity(item, [commented(2, bot("coderabbitai[bot]")), labeled(1, "incomplete")]), NOW - 30 * DAY);
  assert.equal(stale.lastActivity(item, [commented(3, human("outsider"))]), NOW - 3 * DAY);
  assert.equal(stale.lastActivity(item, [committed(4)]), NOW - 4 * DAY);
  assert.equal(stale.lastActivity(item, [unlabeled(5, "stale")]), NOW - 5 * DAY);
  assert.equal(stale.lastActivity(item, [unlabeled(5, "incomplete", human("maintainer"))]), NOW - 30 * DAY);
});

test("a push of old commits counts through an update no timeline event explains", () => {
  const pushed = pr(1, "outsider", { created: ago(30), updated: ago(2) });
  assert.equal(stale.lastActivity(pushed, [committed(25), labeled(20, "incomplete")]), NOW - 2 * DAY);
  const botTouched = pr(2, "outsider", { created: ago(30), updated: ago(9) });
  assert.equal(stale.lastActivity(botTouched, [committed(25), labeled(9, "incomplete")]), NOW - 25 * DAY);
});

test("a week of quiet nudges, another quiet week after the warning closes, activity in between clears it", () => {
  const quiet = pr(1, "outsider", { labels: ["incomplete"] });
  assert.equal(stale.decide({ pr: quiet, events: [commented(8, human("outsider"))], now: NOW, team }).action, "nudge");
  assert.equal(stale.decide({ pr: quiet, events: [commented(6, human("outsider"))], now: NOW, team }).action, "wait");
  const marked = pr(2, "outsider", { labels: ["incomplete", "stale"] });
  assert.equal(stale.decide({ pr: marked, events: [commented(15, human("outsider")), warned(8), labeled(8, "stale")], now: NOW, team }).action, "close");
  assert.equal(stale.decide({ pr: marked, events: [commented(15, human("outsider")), warned(5), labeled(5, "stale")], now: NOW, team }).action, "wait");
  assert.equal(stale.decide({ pr: marked, events: [warned(8), labeled(8, "stale"), commented(2, human("outsider"))], now: NOW, team }).action, "unstale");
  assert.equal(stale.decide({ pr: pr(3, "outsider", { labels: ["stale"] }), events: [], now: NOW, team }).action, "unstale");
});

test("a stale label added by hand never starts the close countdown", () => {
  const manual = pr(1, "outsider", { labels: ["incomplete", "stale"] });
  const byHand = [commented(20, human("outsider")), labeled(10, "stale", human("maintainer"))];
  assert.equal(stale.decide({ pr: manual, events: byHand, now: NOW, team }).action, "nudge");
  const someoneElse = [commented(20, human("outsider")), commented(10, human("maintainer"), stale.WARNED_MARKER), labeled(10, "stale", human("maintainer"))];
  assert.equal(stale.decide({ pr: manual, events: someoneElse, now: NOW, team }).action, "nudge");
  const recent = [commented(3, human("outsider")), labeled(2, "stale", human("maintainer"))];
  assert.equal(stale.decide({ pr: manual, events: recent, now: NOW, team }).action, "wait");
});

test("protected pull requests are left alone even when they carry stale", () => {
  for (const keep of ["ready", "keep-open", "pinned", "vouch:trusted"]) {
    const kept = pr(1, "outsider", { labels: ["incomplete", "stale", keep] });
    assert.equal(stale.decide({ pr: kept, events: [warned(9)], now: NOW, team }).action, "skip", keep);
  }
  const owner = pr(2, "mantrakp04", { labels: ["incomplete", "stale"] });
  assert.equal(stale.decide({ pr: owner, events: [warned(9)], now: NOW, team }).action, "skip");
});

test("the notes say what is missing in two lines and carry their markers", () => {
  const both = pr(1, "outsider", { labels: ["incomplete", "needs-rebase"] });
  const nudge = stale.nudgeBody(both);
  const [first, second, marker] = nudge.split("\n");
  assert.equal(marker, stale.WARNED_MARKER);
  assert.match(first, /@outsider/);
  assert.match(first, /needs a rebase/);
  assert.match(first, /CONTRIBUTING\.md/);
  assert.match(second, /closes in 7 days/);
  const close = stale.closeBody(pr(2, "outsider", { labels: ["needs-rebase"] })).split("\n");
  assert.equal(close.length, 3);
  assert.equal(close[2], stale.CLOSED_MARKER);
  assert.match(close[0], /14 days/);
  assert.match(close[1], /comment here and it reopens/);
  assert.match(stale.needsOf(pr(3, "outsider", { labels: ["vouch:unvouched"] })), /waiting on an update/);
});

function sweepFixture(options = {}) {
  const pulls = [
    pr(1, "quiet", { labels: ["incomplete"] }),
    pr(2, "marked", { labels: ["needs-rebase", "stale"], updated: ago(9) }),
    pr(3, "fresh", { labels: ["incomplete"], updated: ago(1) }),
    pr(4, "mantrakp04", { labels: ["incomplete"] }),
    pr(5, "answered", { labels: ["incomplete", "stale"], updated: ago(1) }),
    pr(6, "kept", { labels: ["incomplete", "stale", "keep-open"] }),
    pr(7, "unlabelled", { labels: ["stale"] }),
  ];
  const timelines = {
    1: [commented(10, human("quiet"))],
    2: [commented(20, human("marked")), warned(9), labeled(9, "stale")],
    5: [warned(9), labeled(9, "stale"), commented(1, human("answered"))],
  };
  return fakeGithub({ pulls, timelines, ...options });
}

test("the sweep nudges, closes and clears, and never touches fresh, team or protected pull requests", async () => {
  const github = sweepFixture();
  const report = await runWith(github, "schedule");
  assert.deepEqual(
    { nudge: report.nudge, close: report.close, unstale: report.unstale, deferred: report.deferred, stopped: report.stopped },
    { nudge: [1], close: [2], unstale: [5, 7], deferred: [], stopped: null },
  );
  assert.deepEqual(
    writes(github).map((call) => [call.name, call.params.issue_number || call.params.pull_number]),
    [
      ["issues.createLabel", undefined],
      ["issues.createComment", 1],
      ["issues.addLabels", 1],
      ["issues.createComment", 2],
      ["pulls.update", 2],
      ["issues.removeLabel", 5],
      ["issues.removeLabel", 7],
    ],
  );
  const touched = github.calls.map((call) => call.params.issue_number || call.params.pull_number);
  for (const untouched of [3, 4, 6]) assert.equal(touched.includes(untouched), false, `#${untouched}`);
  assert.equal(writes(github).find((call) => call.name === "pulls.update").params.state, "closed");
});

test("every write is paced, not only the first of each pull request", async () => {
  let paced = 0;
  const github = sweepFixture();
  await runWith(github, "schedule", {}, { onPaced: (count) => { paced = count; } });
  assert.equal(paced, writes(github).length - 1);
});

test("a dry-run dispatch writes nothing but reports the same plan", async () => {
  const github = sweepFixture();
  const report = await runWith(github, "workflow_dispatch", { inputs: { dry_run: "true" } });
  assert.deepEqual([report.nudge, report.close, report.unstale], [[1], [2], [5, 7]]);
  assert.deepEqual(writes(github), []);
});

test("a pull request that gains keep-open or a comment during the sweep is not closed", async () => {
  const kept = sweepFixture({ current: { 2: pr(2, "marked", { labels: ["needs-rebase", "stale", "keep-open"] }) } });
  const keptReport = await runWith(kept, "schedule");
  assert.deepEqual(keptReport.close, []);
  assert.deepEqual(keptReport.changed, [2]);
  assert.equal(writes(kept).some((call) => (call.params.issue_number || call.params.pull_number) === 2), false);

  const answered = sweepFixture({
    timelines: {
      1: [commented(10, human("quiet"))],
      2: (read) => [commented(20, human("marked")), warned(9), labeled(9, "stale"), ...(read > 1 ? [commented(0, human("marked"))] : [])],
    },
  });
  const answeredReport = await runWith(answered, "schedule");
  assert.deepEqual(answeredReport.close, []);
  assert.deepEqual(answeredReport.unstale.includes(2), true);
  assert.equal(writes(answered).some((call) => call.name === "pulls.update"), false);
});

test("a close is not announced twice when the comment landed but the close did not", async () => {
  const github = sweepFixture({
    pulls: [pr(2, "marked", { labels: ["needs-rebase", "stale"], updated: ago(9) })],
    timelines: { 2: [commented(20, human("marked")), warned(9), labeled(9, "stale"), closeNote(1)] },
  });
  await runWith(github, "schedule");
  assert.deepEqual(writes(github).map((call) => call.name), ["pulls.update"]);
});

test("the sweep stops at its cap and defers the rest", async () => {
  const pulls = [1, 2, 3, 4, 5].map((number) => pr(number, `quiet${number}`, { labels: ["incomplete"] }));
  const github = fakeGithub({ pulls });
  const report = await runWith(github, "schedule", {}, { limit: 2 });
  assert.deepEqual(report.nudge, [1, 2]);
  assert.deepEqual(report.deferred, [3, 4, 5]);
  assert.equal(writes(github).filter((call) => call.name === "issues.createComment").length, 2);
  const dispatched = await runWith(fakeGithub({ pulls }), "workflow_dispatch", { inputs: { dry_run: "true", max_prs: 3 } });
  assert.deepEqual(dispatched.nudge, [1, 2, 3]);
  assert.equal(stale.MAX_PRS_PER_RUN, 40);
});

test("a rate limit stops the sweep cleanly with a summary instead of failing", async () => {
  const pulls = [1, 2, 3].map((number) => pr(number, `quiet${number}`, { labels: ["incomplete"] }));
  const limited = Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403, response: { headers: {} } });
  const github = fakeGithub({ pulls, failOn: (name, params) => (name === "issues.createComment" && params.issue_number === 2 ? limited : null) });
  const core = fakeCore();
  const report = await runWith(github, "schedule", {}, { core });
  assert.match(report.stopped, /#2/);
  assert.equal(writes(github).some((call) => call.params.issue_number === 3), false);
  assert.ok(core.lines.some((line) => /stopped: rate limited at #2/.test(line)));
  assert.equal(stale.isRateLimit({ status: 429 }), true);
  assert.equal(stale.isRateLimit({ status: 403, message: "Resource not accessible by integration", response: { headers: {} } }), false);
  const forbidden = fakeGithub({ pulls, failOn: (name) => (name === "issues.createComment" ? Object.assign(new Error("nope"), { status: 403 }) : null) });
  await assert.rejects(runWith(forbidden, "schedule"));
});

test("the live pull request is checked again right before it closes", async () => {
  const listed = pr(2, "marked", { labels: ["needs-rebase", "stale"], updated: ago(9) });
  const timelines = { 2: [commented(20, human("marked")), warned(9), labeled(9, "stale")] };
  for (const [why, late] of [
    ["keep-open", pr(2, "marked", { labels: ["needs-rebase", "stale", "keep-open"] })],
    ["ready", pr(2, "marked", { labels: ["ready", "stale"] })],
    ["label cleared by a comment", pr(2, "marked", { labels: ["needs-rebase"] })],
  ]) {
    const github = fakeGithub({ pulls: [listed], timelines, current: { 2: (read) => (read === 1 ? listed : late) } });
    const report = await runWith(github, "schedule");
    assert.deepEqual(report.close, [], why);
    assert.deepEqual(report.changed, [2], why);
    assert.equal(writes(github).some((call) => call.name === "pulls.update"), false, why);
  }
});

test("what changes during the wait before the close keeps the pull request open", async () => {
  const before = { labels: ["needs-rebase", "stale"], updated: ago(9) };
  const quiet = [commented(20, human("marked")), warned(9), labeled(9, "stale")];
  const reviewed = { event: "reviewed", submitted_at: new Date(NOW).toISOString(), actor: human("marked"), user: human("marked") };
  for (const [why, change] of [
    ["keep-open", (state) => { state.pr = pr(2, "marked", { labels: [...before.labels, "keep-open"], updated: ago(9) }); }],
    ["stale removed", (state) => { state.pr = pr(2, "marked", { labels: ["needs-rebase"], updated: ago(9) }); }],
    ["review", (state) => { state.events = [...state.events, reviewed]; }],
  ]) {
    const state = { pr: pr(2, "marked", before), events: quiet };
    const github = fakeGithub({ pulls: [state.pr], current: { 2: () => state.pr }, timelines: { 2: () => state.events } });
    let changed = false;
    const pace = async () => {
      const noted = github.calls.some((call) => call.name === "issues.createComment" && call.params.body.includes(stale.CLOSED_MARKER));
      if (noted && !changed) {
        changed = true;
        change(state);
      }
    };
    const report = await runWith(github, "schedule", {}, { pace });
    assert.equal(changed, true, why);
    assert.deepEqual(report.close, [], why);
    assert.equal(writes(github).some((call) => call.name === "pulls.update"), false, why);
    const lastCalls = github.calls.slice(-2).map((call) => call.name);
    assert.deepEqual(lastCalls, ["issues.listEventsForTimeline", "pulls.get"], why);
  }
});

test("a protection label arriving during the final timeline read stops the close", async () => {
  const before = pr(2, "marked", { labels: ["needs-rebase", "stale"], updated: ago(9) });
  const quiet = [commented(20, human("marked")), warned(9), labeled(9, "stale")];
  let timelineReads = 0;
  let protectedNow = false;
  const github = fakeGithub({
    pulls: [before],
    current: { 2: () => (protectedNow ? pr(2, "marked", { labels: ["needs-rebase", "stale", "keep-open"], updated: ago(9) }) : before) },
    timelines: {
      2: () => {
        timelineReads += 1;
        if (timelineReads === 3) {
          protectedNow = true;
          return [...quiet, { event: "labeled", created_at: new Date(NOW).toISOString(), label: { name: "keep-open" } }];
        }
        return quiet;
      },
    },
  });
  const report = await runWith(github, "schedule");
  assert.deepEqual(report.close, []);
  assert.deepEqual(report.changed, [2]);
  assert.equal(writes(github).some((call) => call.name === "pulls.update"), false);
});

test("the close lands right after its final check, with no wait between them", async () => {
  const github = sweepFixture({ pulls: [pr(2, "marked", { labels: ["needs-rebase", "stale"], updated: ago(9) })] });
  const order = [];
  const pace = async () => { order.push("pace"); };
  await runWith(github, "schedule", {}, { pace });
  const names = github.calls.map((call) => call.name);
  const update = names.lastIndexOf("pulls.update");
  assert.deepEqual(names.slice(update - 2, update + 1), ["issues.listEventsForTimeline", "pulls.get", "pulls.update"]);
  assert.equal(order.length, 1);
});

test("a warning whose label never landed still gets the label before the close", async () => {
  const unlabelled = pr(2, "marked", { labels: ["needs-rebase"], updated: ago(9) });
  const github = fakeGithub({
    pulls: [unlabelled],
    timelines: { 2: [commented(20, human("marked")), warned(9)] },
    current: { 2: (read) => (read === 1 ? unlabelled : pr(2, "marked", { labels: ["needs-rebase", "stale"] })) },
  });
  const report = await runWith(github, "schedule");
  assert.deepEqual(report.close, [2]);
  assert.deepEqual(
    writes(github).map((call) => call.name),
    ["issues.createLabel", "issues.addLabels", "issues.createComment", "pulls.update"],
  );
});

test("a rate limit on a read stops the sweep cleanly too", async () => {
  const limited = () => Object.assign(new Error("API rate limit exceeded"), { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } });
  const pulls = [1, 2].map((number) => pr(number, `quiet${number}`, { labels: ["incomplete"] }));
  for (const [where, failOn, pattern] of [
    ["list", (name) => (name === "pulls.list" ? limited() : null), /listing pull requests/],
    ["timeline", (name, params) => (name === "issues.listEventsForTimeline" && params.issue_number === 2 ? limited() : null), /#2/],
    ["get", (name, params) => (name === "pulls.get" && params.pull_number === 1 ? Object.assign(new Error("slow down"), { status: 429 }) : null), /#1/],
  ]) {
    const core = fakeCore();
    const report = await runWith(fakeGithub({ pulls, failOn }), "schedule", {}, { core });
    assert.match(report.stopped, pattern, where);
    assert.ok(core.lines.some((line) => /- stopped: rate limited/.test(line)), where);
  }
});

test("a push or edit by a person clears the label at once; a bot's does not, nor on protected pull requests", async () => {
  const pull = pr(1, "outsider", { labels: ["incomplete", "stale"] });
  const kept = pr(2, "outsider", { labels: ["incomplete", "stale", "keep-open"] });
  const github = fakeGithub({ current: { 1: pull, 2: kept } });
  assert.equal(await runWith(github, "pull_request_target", { pull_request: pull, sender: human("outsider") }), "unstale");
  assert.equal(await runWith(github, "pull_request_target", { pull_request: pull, sender: bot("github-actions[bot]") }), null);
  assert.equal(await runWith(github, "pull_request_target", { pull_request: kept, sender: human("outsider") }), null);
  assert.deepEqual(writes(github).map((call) => call.name), ["issues.removeLabel"]);
});

function closedPull(number, login, { merged_at = null, labels = ["incomplete", "stale"] } = {}) {
  return { ...pr(number, login, { labels, state: "closed" }), merged_at, pull_request: { merged_at } };
}

function openIssue(number, labels) {
  return { ...pr(number, "outsider", { labels }), pull_request: {} };
}

test("a comment on an open stale pull request clears the label unless it is protected", async () => {
  const issue = openIssue(1, ["incomplete", "stale"]);
  const ready = openIssue(2, ["ready", "stale"]);
  const github = fakeGithub({ current: { 1: issue, 2: ready } });
  assert.equal(await runWith(github, "issue_comment", { issue, comment: { user: human("someone") } }), "unstale");
  assert.equal(await runWith(github, "issue_comment", { issue, comment: { user: bot("coderabbitai[bot]") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: ready, comment: { user: human("someone") } }), null);
  assert.deepEqual(writes(github).map((call) => call.name), ["issues.removeLabel"]);
});

test("a comment handler reads the live pull request, not the webhook's copy", async () => {
  const github = fakeGithub({
    current: {
      1: pr(1, "outsider", { labels: ["incomplete", "stale", "keep-open"] }),
      2: pr(2, "outsider", { labels: ["incomplete"] }),
    },
  });
  assert.equal(await runWith(github, "issue_comment", { issue: openIssue(1, ["incomplete", "stale"]), comment: { user: human("someone") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: openIssue(2, ["incomplete", "stale"]), comment: { user: human("someone") } }), null);
  assert.equal(
    await runWith(github, "pull_request_target", { pull_request: pr(1, "outsider", { labels: ["incomplete", "stale"] }), sender: human("outsider") }),
    null,
  );
  assert.deepEqual(writes(github), []);
});

const vouchNote = (days) => commented(days, ACTIONS_BOT, "Closed for @someone.");

test("reopening goes by timeline order, not by how close the timestamps are", async () => {
  const at = (iso, event) => ({ ...event, created_at: iso });
  const second = "2026-11-14T12:00:00Z";
  const nextSecond = "2026-11-14T12:00:01Z";
  const github = fakeGithub({
    current: { 1: closedPull(1, "outsider"), 2: closedPull(2, "outsider"), 3: closedPull(3, "outsider") },
    timelines: {
      1: [warned(15), at(second, closed(8)), at(nextSecond, closeNote(8))],
      2: [warned(15), at(second, closeNote(8)), { event: "reopened", created_at: second, actor: human("mantrakp04") }, at(second, closed(8))],
      3: [warned(15), at(second, closeNote(8)), at(second, closed(8))],
    },
  });
  const comment = (number) => runWith(github, "issue_comment", { issue: closedPull(number, "outsider"), comment: { user: human("outsider") } });
  assert.equal(await comment(1), null);
  assert.equal(await comment(2), null);
  assert.equal(await comment(3), "reopen");
});

test("the author's comment reopens a pull request the sweep closed, and only that", async () => {
  const closedPulls = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((number) => [number, closedPull(number, "outsider")]));
  const github = fakeGithub({
    current: closedPulls,
    timelines: {
      1: [warned(15), closeNote(8), closed(8)],
      2: [warned(15), closeNote(8), closed(8), { event: "reopened", created_at: ago(6), actor: human("mantrakp04") }, closed(5, human("mantrakp04"))],
      4: [warned(15), closed(8)],
      5: [warned(15), closeNote(8), closed(3)],
      6: [warned(15), closeNote(8), vouchNote(3), closed(3)],
      7: [warned(15), closeNote(8), { event: "reopened", created_at: ago(6), actor: human("mantrakp04") }, closed(3)],
    },
  });
  const comment = (number, login, options) => runWith(github, "issue_comment", { issue: closedPull(number, "outsider", options), comment: { user: human(login) } });
  assert.equal(await comment(1, "Outsider"), "reopen");
  assert.equal(await comment(1, "bystander"), null);
  assert.equal(await comment(2, "outsider"), null);
  assert.equal(await comment(3, "outsider", { merged_at: ago(1) }), null);
  assert.equal(await comment(4, "outsider"), null);
  assert.equal(await comment(5, "outsider"), "reopen");
  assert.equal(await comment(6, "outsider"), null);
  assert.equal(await comment(7, "outsider"), null);
  assert.deepEqual(
    writes(github).map((call) => [call.name, call.params.pull_number || call.params.issue_number, call.params.state || call.params.name]),
    [["pulls.update", 1, "open"], ["issues.removeLabel", 1, "stale"], ["pulls.update", 5, "open"], ["issues.removeLabel", 5, "stale"]],
  );
});

test("a denounced author's pull request closed by Vouch is never reopened", async () => {
  const github = fakeGithub({
    current: {
      1: closedPull(1, "spammer", { labels: ["incomplete", "stale", "vouch:denounced"] }),
      2: closedPull(2, "spammer"),
      3: closedPull(3, "outsider", { labels: ["incomplete", "stale", "vouch:denounced"] }),
    },
    timelines: {
      1: [warned(15), closeNote(1), closed(1)],
      2: [warned(15), closeNote(8), closed(8)],
      3: [warned(15), closeNote(8), closed(8)],
    },
  });
  const labelled = closedPull(1, "spammer", { labels: ["incomplete", "stale", "vouch:denounced"] });
  assert.equal(await runWith(github, "issue_comment", { issue: labelled, comment: { user: human("spammer") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(2, "spammer"), comment: { user: human("spammer") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(3, "outsider"), comment: { user: human("outsider") } }), null);
  assert.deepEqual(writes(github), []);
});

test("a pull request that can't reopen gets one line asking for a new one", async () => {
  const github = fakeGithub({
    current: { 1: closedPull(1, "outsider") },
    timelines: { 1: [warned(15), closeNote(8), closed(8)] },
    failOn: (name, params) => (name === "pulls.update" && params.state === "open" ? Object.assign(new Error("branch gone"), { status: 422 }) : null),
  });
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(1, "outsider"), comment: { user: human("outsider") } }), "unreopenable");
  const comment = writes(github).find((call) => call.name === "issues.createComment");
  assert.match(comment.params.body, /open a new pull request/);
});
