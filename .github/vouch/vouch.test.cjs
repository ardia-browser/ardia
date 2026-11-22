const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vouch = require("./vouch.cjs");

const FILES = {
  list: [
    "# maintainers vouch below",
    "",
    "Alice",
    "github:Bob",
    "-mallory spam and abuse",
    "-github:Eve",
    "  carol  ",
    "gitlab:dave",
  ].join("\n"),
  team: "shivamhwp\nmantrakp04\n",
  unvouchedNote: "Hi @{author}, see {owner}/{repo} on {default_branch}.",
  denouncedNote: "Closed for @{author}.",
  overLimitNote: "@{author}, more than {limit} open, see {owner}/{repo} on {default_branch}.",
  takenNote: "@{holder} is already working on this.",
  takenPullNote: "@{holder} is already working on this in #{pull}.",
  takeNotABugNote: "@{author}, bug fixes only, see {owner}/{repo} on {default_branch}.",
  takeOverLimitNote: "@{author}, you hold {limit} issues already.",
};

const WRITE_METHODS = new Set([
  "issues.addLabels",
  "issues.removeLabel",
  "issues.createLabel",
  "issues.createComment",
  "issues.update",
  "issues.addAssignees",
  "issues.removeAssignees",
  "reactions.createForIssueComment",
  "graphql.VouchMinimize",
  "pulls.update",
  "actions.reRunWorkflow",
  "repos.createCommitStatus",
]);

function restUser(login) {
  return { login, type: login.endsWith("[bot]") ? "Bot" : "User" };
}

function pr(number, login, { labels = [], state = "open", sha = `sha${number}`, association, assignees = [], ...rules } = {}) {
  return {
    number,
    state,
    author_association: association,
    user: login === null ? null : { login },
    assignees: assignees.map(restUser),
    labels: labels.map((name) => ({ name })),
    head: { sha, ref: `branch${number}`, repo: { full_name: `fork${number}/ardia` } },
    created_at: rules.created_at,
    rules,
  };
}

const NEW = "2026-11-15T09:00:00Z";
const CLAIMED = "2026-11-17T09:00:00Z";
const NOW = "2026-11-18T09:00:00Z";
const OLD = "2026-11-01T09:00:00Z";
const SHOT = "![shot](https://github.com/user-attachments/assets/0f3a)";

function fresh(number, login, options = {}) {
  return pr(number, login, {
    created_at: NEW,
    body: `Closes #100\n\n${SHOT}`,
    mergeable: "MERGEABLE",
    base: "main",
    linked: [100],
    ...options,
  });
}

function graphAuthor(login) {
  if (!login) return null;
  return login.endsWith("[bot]") ? { __typename: "Bot", login: login.slice(0, -5) } : { __typename: "User", login };
}

function closersOf(pulls, number) {
  return pulls
    .filter((item) => (item.rules.linked || []).includes(number))
    .map((item) => ({
      number: item.number,
      state: item.state.toUpperCase(),
      createdAt: item.rules.created_at || null,
      closedAt: item.rules.closed_at || null,
      author: graphAuthor(item.user && item.user.login),
    }));
}

function graphComment(item) {
  return {
    id: item.node_id,
    databaseId: item.id,
    isMinimized: Boolean(item.minimized),
    createdAt: item.created_at || null,
    authorAssociation: item.author_association || "NONE",
    author: graphAuthor(item.user && item.user.login),
    body: item.body || "",
  };
}

function issueNode(number, issues, pulls, comments = {}) {
  const issue = issues.find((candidate) => candidate.number === number);
  if (issue && issue.pull_request) return { __typename: "PullRequest" };
  const found = issue || { state: "open", labels: [], assignees: [], rules: {} };
  return {
    __typename: "Issue",
    number,
    state: found.state.toUpperCase(),
    labels: { nodes: found.labels },
    assignees: { nodes: found.assignees.map((assignee) => graphAuthor(assignee.login)) },
    closedByPullRequestsReferences: { nodes: closersOf(pulls, number) },
    timelineItems: { nodes: ((found.rules || {}).assigned || []).map((event) => ({ createdAt: event.at, assignee: graphAuthor(event.login) })) },
    comments: { nodes: (comments[number] || []).map(graphComment) },
    everyPull: { nodes: closersOf(pulls, number) },
  };
}

function graphNode(item, issues, mergeableOf, pulls = []) {
  const rules = item.rules || {};
  return {
    number: item.number,
    state: item.state.toUpperCase(),
    isDraft: Boolean(rules.draft),
    createdAt: rules.created_at || null,
    body: rules.body || "",
    mergeable: mergeableOf(item),
    baseRefName: rules.base || "main",
    headRefOid: item.head.sha,
    authorAssociation: item.author_association || "NONE",
    author: graphAuthor(item.user && item.user.login),
    labels: { nodes: item.labels },
    closingIssuesReferences: { nodes: (rules.linked || []).map((number) => issueNode(number, issues, pulls)) },
    reviewThreads: {
      nodes: (rules.threads || []).map((thread) => ({
        isResolved: Boolean(thread.resolved),
        comments: { nodes: [{ author: graphAuthor(thread.by) }] },
      })),
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: item.head.sha,
            status: rules.bugFix ? { context: rules.bugFix } : null,
            statusCheckRollup: rules.checks ? { contexts: { nodes: rules.checks } } : null,
          },
        },
      ],
    },
  };
}

function runOf(number, id, status = "completed", conclusion = status === "completed" ? "success" : null) {
  return { id, status, conclusion, head_branch: `branch${number}`, head_repository: { full_name: `fork${number}/ardia` } };
}

const GATE_SKIPPED = [{ name: "gate", conclusion: "success" }, { name: "app", conclusion: "skipped" }];
const BUILT = [{ name: "gate", conclusion: "success" }, { name: "app", conclusion: "success" }];

function fakeGithub({
  permissions = {},
  pulls = [],
  issues = [],
  comments = {},
  repoLabels = vouch.LABEL_SPECS.map(({ name }) => ({ name })),
  runs = {},
  androidRuns = {},
  linuxRuns = {},
  windowsRuns = {},
  macRuns = {},
  jobs = {},
  currentList = FILES.list,
  defaultBranch = "main",
  unassignable = [],
} = {}) {
  const calls = [];
  let commentSeq = 9000;
  const issueByNumber = (number) => issues.find((issue) => issue.number === number);
  const assignedTo = (issue, login) => issue.assignees.some((assignee) => assignee.login.toLowerCase() === login.toLowerCase());
  const record = (name, handler) => async (params) => {
    calls.push({ name, params });
    return handler(params || {});
  };
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const rest = {
    repos: {
      getContent: record("repos.getContent", () => ({
        data: { content: Buffer.from(currentList).toString("base64"), encoding: "base64" },
      })),
      getCollaboratorPermissionLevel: record("repos.getCollaboratorPermissionLevel", ({ username }) => {
        const permission = permissions[username];
        if (!permission) throw notFound();
        return { data: { permission } };
      }),
      createCommitStatus: record("repos.createCommitStatus", () => ({ data: {} })),
    },
    pulls: {
      list: record("pulls.list", ({ state }) => ({
        data: state === "open" ? pulls.filter((item) => item.state === "open") : pulls,
      })),
      get: record("pulls.get", ({ pull_number }) => ({ data: pulls.find((item) => item.number === pull_number) })),
      update: record("pulls.update", () => ({ data: {} })),
    },
    issues: {
      listLabelsForRepo: record("issues.listLabelsForRepo", () => ({ data: repoLabels })),
      createLabel: record("issues.createLabel", () => ({ data: {} })),
      addLabels: record("issues.addLabels", () => ({ data: [] })),
      removeLabel: record("issues.removeLabel", () => ({ data: [] })),
      listComments: record("issues.listComments", ({ issue_number }) => ({ data: comments[issue_number] || [] })),
      createComment: record("issues.createComment", ({ issue_number, body }) => {
        commentSeq += 1;
        const created = { id: commentSeq, node_id: `IC_${commentSeq}`, user: { login: "github-actions[bot]" }, body, created_at: "2026-11-18T00:00:00Z" };
        comments[issue_number] = [...(comments[issue_number] || []), created];
        return { data: created };
      }),
      update: record("issues.update", () => ({ data: {} })),
      get: record("issues.get", ({ issue_number }) => {
        const found = issues.find((issue) => issue.number === issue_number);
        if (!found) throw notFound();
        return { data: found };
      }),
      listForRepo: record("issues.listForRepo", ({ creator, assignee }) => {
        const open = issues.filter((issue) => issue.state === "open");
        if (assignee === "*") return { data: open.filter((issue) => issue.assignees.length) };
        if (assignee) return { data: open.filter((issue) => assignedTo(issue, assignee)) };
        return { data: open.filter((issue) => issue.user && issue.user.login === creator) };
      }),
      addAssignees: record("issues.addAssignees", ({ issue_number, assignees }) => {
        const issue = issueByNumber(issue_number);
        for (const login of assignees) {
          if (!unassignable.includes(login) && !assignedTo(issue, login)) issue.assignees.push(restUser(login));
        }
        return { data: { ...issue, assignees: [...issue.assignees] } };
      }),
      removeAssignees: record("issues.removeAssignees", ({ issue_number, assignees }) => {
        const issue = issueByNumber(issue_number);
        issue.assignees = issue.assignees.filter((assignee) => !assignees.some((login) => login.toLowerCase() === assignee.login.toLowerCase()));
        return { data: { ...issue, assignees: [...issue.assignees] } };
      }),
    },
    reactions: {
      createForIssueComment: record("reactions.createForIssueComment", () => ({ data: {} })),
    },
    actions: {
      listWorkflowRuns: record("actions.listWorkflowRuns", ({ head_sha, workflow_id }) => {
        const found = ({ "ios.yml": runs, "android.yml": androidRuns, "linux.yml": linuxRuns, "windows.yml": windowsRuns, "mac.yml": macRuns }[workflow_id] || {})[head_sha] || [];
        return { data: { workflow_runs: typeof found === "function" ? found() : found } };
      }),
      listJobsForWorkflowRun: record("actions.listJobsForWorkflowRun", ({ run_id }) => ({ data: jobs[run_id] || [] })),
      reRunWorkflow: record("actions.reRunWorkflow", () => ({ data: {} })),
    },
  };
  const mergeableReads = {};
  const mergeableOf = (item) => {
    const answers = [].concat((item.rules || {}).mergeable || "MERGEABLE");
    const read = mergeableReads[item.number] || 0;
    mergeableReads[item.number] = read + 1;
    return answers[Math.min(read, answers.length - 1)];
  };
  const pullByNumber = (number) => pulls.find((item) => item.number === number);
  const graphql = async (query, variables) => {
    const operation = /(?:query|mutation) (\w+)/.exec(query)[1];
    calls.push({ name: `graphql.${operation}`, params: variables });
    const defaultBranchRef = { name: defaultBranch };
    if (operation === "VouchMinimize") {
      const found = Object.values(comments).flat().find((item) => item.node_id === variables.id);
      found.minimized = variables.classifier;
      return { minimizeComment: { minimizedComment: { isMinimized: true } } };
    }
    if (["VouchIssueClaim", "VouchIssueThread", "VouchIssuePulls"].includes(operation)) {
      return { repository: { issueOrPullRequest: issueNode(variables.number, issues, pulls, comments) } };
    }
    if (operation === "VouchPullIssues") {
      const item = pullByNumber(variables.number);
      const pullRequest = item && {
        body: item.rules.body || "",
        baseRefName: item.rules.base || "main",
        closingIssuesReferences: { nodes: (item.rules.linked || []).map((number) => ({ number })) },
      };
      return { repository: { defaultBranchRef, pullRequest } };
    }
    if (operation === "VouchRulePull") {
      const item = pullByNumber(variables.number);
      return { repository: { defaultBranchRef, pullRequest: item ? graphNode(item, issues, mergeableOf, pulls) : null } };
    }
    if (operation === "VouchMergeable") {
      const item = pullByNumber(variables.number);
      return { repository: { pullRequest: item ? { mergeable: mergeableOf(item) } : null } };
    }
    if (operation === "VouchRulePulls") {
      const open = pulls
        .filter((item) => item.state === "open")
        .sort((a, b) => String(b.rules.created_at || "").localeCompare(String(a.rules.created_at || "")));
      const start = variables.after ? Number(variables.after) : 0;
      const page = open.slice(start, start + variables.first);
      const end = start + page.length;
      return {
        repository: {
          defaultBranchRef,
          pullRequests: {
            pageInfo: { hasNextPage: end < open.length, endCursor: String(end) },
            nodes: page.map((item) => graphNode(item, issues, mergeableOf, pulls)),
          },
        },
      };
    }
    throw new Error(`Unexpected query ${operation}`);
  };
  const paginate = async (method, params) => (await method(params)).data;
  const writes = () => calls.filter((call) => WRITE_METHODS.has(call.name));
  const named = (name) => calls.filter((call) => call.name === name);
  return { rest, graphql, paginate, calls, writes, named };
}

function fakeCore() {
  const outputs = {};
  const summaries = [];
  const summary = {
    text: "",
    addRaw(text) {
      this.text += text;
      return this;
    },
    async write() {
      summaries.push(this.text);
      this.text = "";
      return this;
    },
  };
  const warnings = [];
  return { outputs, summaries, summary, warnings, info() {}, warning: (message) => warnings.push(message), setOutput: (key, value) => (outputs[key] = value) };
}

function context(eventName, payload = {}) {
  return {
    eventName,
    repo: { owner: "acme", repo: "ardia" },
    payload: { repository: { default_branch: "main" }, ...payload },
  };
}

async function invoke(entry, { github, eventName, payload, env = {}, now = () => Date.parse(NOW) }) {
  const core = fakeCore();
  const result = await vouch[entry]({ github, context: context(eventName, payload), core, files: FILES, env, now, pace: async () => {}, settle: async () => {} });
  return { core, result };
}

test("the list parser handles plain names, the github prefix, denounced reasons, comments, blanks and case", () => {
  const list = vouch.parseVouchedList(FILES.list);
  assert.deepEqual([...list.keys()].sort(), ["alice", "bob", "carol", "eve", "mallory"]);
  assert.deepEqual(list.get("mallory"), { denounced: true, reason: "spam and abuse" });
  assert.deepEqual(list.get("eve"), { denounced: true, reason: null });
  assert.deepEqual(list.get("alice"), { denounced: false, reason: null });
  assert.equal(vouch.listStatus(list, "ALICE"), "vouched");
  assert.equal(vouch.listStatus(list, "dave"), "unknown");
});

test("status order: bot, then collaborator, then the list, then unknown", () => {
  const list = vouch.parseVouchedList(FILES.list);
  assert.equal(vouch.authorStatus({ list, login: "mallory[bot]", permission: "none" }), "bot");
  assert.equal(vouch.authorStatus({ list, login: "mallory", permission: "admin" }), "collaborator");
  assert.equal(vouch.authorStatus({ list, login: "mallory", permission: "write" }), "collaborator");
  assert.equal(vouch.authorStatus({ list, login: "Mallory", permission: "read" }), "denounced");
  assert.equal(vouch.authorStatus({ list, login: "alice", permission: "none" }), "vouched");
  assert.equal(vouch.authorStatus({ list, login: "stranger", permission: "read" }), "unknown");
  assert.equal(vouch.authorStatus({ list, login: null }), "unknown");
  assert.equal(vouch.labelForStatus("bot"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("collaborator"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("vouched"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("unknown"), vouch.UNVOUCHED);
  assert.equal(vouch.labelForStatus("denounced"), vouch.DENOUNCED);
});

test("a new unvouched pull request gets the label and one filled note, and stays open", async () => {
  const github = fakeGithub();
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(5, "stranger") } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
  const notes = github.named("issues.createComment");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].params.body, "Hi @stranger, see acme/ardia on main.");
  assert.equal(github.named("pulls.update").length, 0);
});

test("the note is not posted twice when the same opened event runs again", async () => {
  const github = fakeGithub({ comments: { 5: [{ body: "Hi @stranger, see acme/ardia on main." }] } });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(5, "stranger") } });
  assert.equal(github.named("issues.createComment").length, 0);
});

test("reopen and /recheck label an unvouched pull request but post no note", async () => {
  const reopened = fakeGithub();
  await invoke("run", { github: reopened, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(6, "stranger") } });
  const recheck = fakeGithub();
  await invoke("run", {
    github: recheck,
    eventName: "issue_comment",
    payload: { action: "created", comment: { body: " /recheck " }, issue: { ...pr(6, "stranger"), pull_request: {} } },
  });
  for (const github of [reopened, recheck]) {
    assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
    assert.equal(github.named("issues.createComment").length, 0);
  }
});

test("a deleted account's pull request is unvouched", async () => {
  const github = fakeGithub();
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(7, null) } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
  assert.equal(github.named("repos.getCollaboratorPermissionLevel").length, 0);
});

test("a denounced author's pull request is labelled, gets the line and is closed", async () => {
  const github = fakeGithub({ permissions: { mallory: "read" } });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(8, "mallory") } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.DENOUNCED]]);
  assert.deepEqual(github.named("issues.createComment").map((call) => call.params.body), ["Closed for @mallory."]);
  assert.deepEqual(github.named("pulls.update").map((call) => call.params), [{ owner: "acme", repo: "ardia", pull_number: 8, state: "closed" }]);
});

test("a denounced author's new issue is closed as not planned; anyone else's issue is untouched", async () => {
  const denounced = fakeGithub();
  await invoke("run", { github: denounced, eventName: "issues", payload: { action: "opened", issue: pr(9, "Eve") } });
  assert.deepEqual(denounced.named("issues.addLabels").map((call) => call.params.labels), [[vouch.DENOUNCED]]);
  assert.equal(denounced.named("issues.createComment").length, 1);
  assert.deepEqual(
    denounced.named("issues.update").map(({ params }) => [params.issue_number, params.state, params.state_reason]),
    [[9, "closed", "not_planned"]],
  );
  const normal = fakeGithub();
  await invoke("run", { github: normal, eventName: "issues", payload: { action: "opened", issue: pr(10, "stranger") } });
  assert.deepEqual(normal.calls, []);
});

test("missing vouch labels are created before the first add", async () => {
  const github = fakeGithub({ repoLabels: [{ name: "vouch:trusted" }] });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(11, "alice") } });
  assert.deepEqual(github.named("issues.createLabel").map((call) => call.params.name), [
    vouch.UNVOUCHED,
    vouch.DENOUNCED,
    vouch.RUN_CI,
    ...vouch.RULE_LABELS,
  ]);
});

function sweepFixture() {
  return fakeGithub({
    permissions: { owner: "admin", mallory: "read" },
    pulls: [
      pr(1, "stranger"),
      pr(2, "alice", { labels: [vouch.UNVOUCHED] }),
      pr(3, "owner", { labels: [vouch.TRUSTED, vouch.UNVOUCHED, "bug"], state: "closed" }),
      pr(4, "dependabot[bot]", { labels: [vouch.TRUSTED] }),
      pr(5, "stranger", { labels: [vouch.UNVOUCHED] }),
      pr(6, "mallory"),
      pr(7, "mallory", { state: "closed", labels: [vouch.DENOUNCED] }),
    ],
    issues: [pr(20, "mallory"), pr(21, "mallory", { state: "closed" }), pr(22, "stranger")],
  });
}

test("the sweep fixes missing, wrong and double labels, closes denounced work and never posts the note", async () => {
  const github = sweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "schedule" });
  const labelWrites = github.calls
    .filter((call) => call.name === "issues.addLabels" || call.name === "issues.removeLabel")
    .map(({ name, params }) => [name, params.issue_number, params.labels ? params.labels[0] : params.name]);
  assert.deepEqual(labelWrites, [
    ["issues.addLabels", 1, vouch.UNVOUCHED],
    ["issues.addLabels", 2, vouch.TRUSTED],
    ["issues.removeLabel", 2, vouch.UNVOUCHED],
    ["issues.removeLabel", 3, vouch.UNVOUCHED],
    ["issues.addLabels", 6, vouch.DENOUNCED],
    ["issues.addLabels", 20, vouch.DENOUNCED],
  ]);
  assert.ok(github.writes().every((call) => ![4, 5, 7].includes(call.params.issue_number ?? call.params.pull_number)));
  assert.deepEqual(github.named("issues.createComment").map((call) => [call.params.issue_number, call.params.body]), [
    [6, "Closed for @mallory."],
    [20, "Closed for @mallory."],
  ]);
  assert.deepEqual(github.named("pulls.update").map((call) => call.params.pull_number), [6]);
  assert.deepEqual(github.named("issues.update").map((call) => call.params.issue_number), [20]);
  assert.deepEqual(result.counts, { [vouch.TRUSTED]: 3, [vouch.UNVOUCHED]: 2, [vouch.DENOUNCED]: 2 });
  assert.equal(core.summaries.length, 1);
  assert.match(core.summaries[0], /pull request #2: vouch:unvouched -> vouch:trusted/);
});

test("the sweep leaves correctly labelled pull requests alone", async () => {
  const github = fakeGithub({
    permissions: { owner: "admin" },
    pulls: [pr(1, "owner", { labels: [vouch.TRUSTED] }), pr(2, "stranger", { labels: [vouch.UNVOUCHED, "bug"] })],
  });
  await invoke("run", { github, eventName: "schedule" });
  assert.deepEqual(github.writes(), []);
});

test("a dry-run sweep writes nothing but reports what it would do", async () => {
  const github = sweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "workflow_dispatch", payload: { inputs: { dry_run: "true" } } });
  assert.deepEqual(github.writes(), []);
  assert.equal(github.named("issues.listLabelsForRepo").length, 0);
  assert.equal(result.changes.length, 5);
  assert.deepEqual(result.closed.map((item) => item.number), [6, 20]);
  assert.match(core.summaries[0], /dry run/);
});

test("an author GitHub reports as an outsider is never looked up; a collaborator is", async () => {
  const github = fakeGithub({
    permissions: { helper: "write" },
    pulls: [pr(1, "stranger", { association: "NONE" }), pr(2, "alice", { association: "CONTRIBUTOR" }), pr(3, "helper", { association: "COLLABORATOR" })],
  });
  const { result } = await invoke("run", { github, eventName: "workflow_dispatch", payload: { inputs: { dry_run: true } } });
  const looked = github.named("repos.getCollaboratorPermissionLevel").map((call) => call.params.username);
  assert.deepEqual(looked.filter((name) => ["stranger", "alice", "helper"].includes(name)), ["helper"]);
  assert.deepEqual(result.counts, { [vouch.TRUSTED]: 2, [vouch.UNVOUCHED]: 1, [vouch.DENOUNCED]: 0 });
});

test("nothing is closed for an author the default branch no longer denounces", async () => {
  const github = fakeGithub({
    currentList: "alice",
    permissions: { mallory: "read" },
    pulls: [pr(6, "mallory")],
    issues: [pr(20, "mallory")],
  });
  const { result } = await invoke("run", { github, eventName: "schedule" });
  assert.deepEqual(github.named("pulls.update"), []);
  assert.deepEqual(github.named("issues.update"), []);
  assert.deepEqual(github.named("issues.createComment"), []);
  assert.deepEqual(result.closed, []);
});

test("collaborator permission is looked up once per login", async () => {
  const github = fakeGithub({ pulls: [pr(1, "Stranger"), pr(2, "stranger"), pr(3, "STRANGER")] });
  await invoke("run", { github, eventName: "schedule" });
  const usernames = github.named("repos.getCollaboratorPermissionLevel").map((call) => call.params.username.toLowerCase());
  assert.deepEqual(usernames.sort(), ["eve", "mallory", "stranger"]);
});

function rerunFixture() {
  return fakeGithub({
    permissions: { owner: "admin" },
    pulls: [
      pr(1, "alice", { labels: [vouch.UNVOUCHED], sha: "a1" }),
      pr(2, "alice", { labels: [vouch.UNVOUCHED], sha: "a2", state: "closed" }),
      pr(3, "alice", { labels: [vouch.TRUSTED], sha: "a3" }),
      pr(4, "stranger", { sha: "s4" }),
      pr(5, "alice", { labels: [vouch.UNVOUCHED], sha: "a5" }),
      pr(6, "alice", { labels: [vouch.UNVOUCHED], sha: "a6" }),
      pr(7, "alice", { labels: [vouch.TRUSTED], sha: "a7" }),
      pr(8, "stranger", { labels: [vouch.UNVOUCHED, vouch.RUN_CI], sha: "s8" }),
      pr(9, "owner", { labels: [vouch.UNVOUCHED], sha: "o9" }),
      pr(10, "alice", { labels: [vouch.TRUSTED], sha: "a10" }),
      pr(11, "alice", { labels: [vouch.TRUSTED], sha: "shared" }),
      pr(12, "stranger", { labels: [vouch.UNVOUCHED], sha: "shared" }),
      pr(13, "alice", { labels: [vouch.TRUSTED], sha: "a13" }),
    ],
    runs: {
      a1: [runOf(1, 101), runOf(1, 100)],
      a2: [runOf(2, 200)],
      a3: [runOf(3, 300)],
      s4: [runOf(4, 400)],
      a5: [runOf(5, 500, "in_progress")],
      a6: [runOf(6, 600)],
      a7: [runOf(7, 700)],
      s8: [runOf(8, 800)],
      o9: [runOf(9, 900)],
      a10: [runOf(10, 1000)],
      shared: [runOf(12, 1200), runOf(11, 1100)],
      a13: [runOf(13, 1300, "completed", "cancelled")],
    },
    jobs: {
      101: GATE_SKIPPED,
      100: GATE_SKIPPED,
      200: GATE_SKIPPED,
      300: GATE_SKIPPED,
      400: GATE_SKIPPED,
      600: BUILT,
      700: [{ name: "gate", conclusion: "failure" }, { name: "app", conclusion: "skipped" }],
      800: GATE_SKIPPED,
      900: GATE_SKIPPED,
      1000: [{ name: "gate", conclusion: "cancelled" }, { name: "app", conclusion: "skipped" }],
      1100: GATE_SKIPPED,
      1200: GATE_SKIPPED,
      1300: [{ name: "gate", conclusion: "success" }, { name: "app", conclusion: "cancelled" }, { name: "packages", conclusion: "skipped" }],
    },
  });
}

const EXPECTED_RERUNS = [101, 300, 800, 900, 1100];

test("listChanged starts the waiting build of every open pull request that is now allowed to build", async () => {
  const github = rerunFixture();
  const { result, core } = await invoke("listChanged", { github, eventName: "issue_comment" });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), EXPECTED_RERUNS);
  assert.deepEqual(result.rerun.map((item) => item.number), [1, 3, 8, 9, 11]);
  const lookups = github.named("actions.listWorkflowRuns").map((call) => call.params);
  assert.ok(lookups.every((params) => vouch.GATED_WORKFLOWS.includes(params.workflow_id) && params.event === "pull_request"));
  for (const workflow of vouch.GATED_WORKFLOWS) {
    const shas = lookups.filter((params) => params.workflow_id === workflow).map((params) => params.head_sha);
    assert.deepEqual(shas, ["a1", "a3", "a5", "a6", "a7", "s8", "o9", "a10", "shared", "a13"], workflow);
  }
  assert.match(core.summaries[0], /Builds started \(5\)/);
});

test("a run that failed or was cancelled, at the gate or after it, is not started again", async () => {
  const github = rerunFixture();
  await invoke("listChanged", { github, eventName: "issue_comment" });
  const rerun = github.named("actions.reRunWorkflow").map((call) => call.params.run_id);
  assert.ok(!rerun.includes(700) && !rerun.includes(1000) && !rerun.includes(1300));
});

test("two pull requests on the same commit each get their own run", async () => {
  const github = rerunFixture();
  await invoke("listChanged", { github, eventName: "issue_comment" });
  const rerun = github.named("actions.reRunWorkflow").map((call) => call.params.run_id);
  assert.ok(rerun.includes(1100) && !rerun.includes(1200));
});

test("an author who gained write access gets a waiting build started", async () => {
  const github = rerunFixture();
  const { result } = await invoke("listChanged", { github, eventName: "issue_comment" });
  assert.ok(result.changes.some((change) => change.number === 9 && change.to === vouch.TRUSTED));
  assert.ok(github.named("actions.reRunWorkflow").some((call) => call.params.run_id === 900));
});

test("a push of the list and the daily sweep start waiting builds too; a dry run starts none", async () => {
  for (const eventName of ["push", "schedule"]) {
    const github = rerunFixture();
    await invoke("run", { github, eventName });
    assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), EXPECTED_RERUNS, eventName);
  }
  const dry = rerunFixture();
  await invoke("run", { github: dry, eventName: "workflow_dispatch", payload: { inputs: { dry_run: "true" } } });
  assert.deepEqual(dry.named("actions.listWorkflowRuns"), []);
});

test("the run-ci label waits for a run that is still deciding, then starts its skipped build", async () => {
  const answers = [[runOf(9, 900, "in_progress")], [runOf(9, 900, "in_progress")], [runOf(9, 900)]];
  const github = fakeGithub({ runs: { s9: () => answers.shift() }, jobs: { 900: GATE_SKIPPED } });
  await invoke("run", {
    github,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "run-ci" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.equal(github.named("actions.listWorkflowRuns").filter((call) => call.params.workflow_id === "ios.yml").length, 3);
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [900]);
});

test("a Windows build waiting at the gate starts with the iPhone one", async () => {
  const windowsWaiting = [
    { name: "gate", conclusion: "success" },
    { name: "javascript", conclusion: "skipped" },
    { name: "app", conclusion: "skipped" },
    { name: "arm64-app", conclusion: "skipped" },
    { name: "x64", conclusion: "skipped" },
    { name: "x64-gate", conclusion: "skipped" },
    { name: "arm64", conclusion: "skipped" },
    { name: "arm64-gate", conclusion: "skipped" },
  ];
  const github = fakeGithub({
    runs: { s9: [runOf(9, 900)] },
    windowsRuns: { s9: [runOf(9, 960)] },
    jobs: { 900: GATE_SKIPPED, 960: windowsWaiting },
  });
  await invoke("run", {
    github,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "run-ci" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [900, 960]);
});

test("the run-ci label re-runs the skipped build of every gated workflow", async () => {
  const github = fakeGithub({
    runs: { s9: [runOf(9, 900)] },
    androidRuns: { s9: [runOf(9, 950)] },
    linuxRuns: { s9: [runOf(9, 970)] },
    macRuns: { s9: [runOf(9, 990)] },
    jobs: { 900: GATE_SKIPPED, 950: GATE_SKIPPED, 970: GATE_SKIPPED, 990: [{ name: "gate", conclusion: "success" }, { name: "compile (Debug)", conclusion: "skipped" }] },
  });
  await invoke("run", {
    github,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "run-ci" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [900, 950, 970, 990]);
});

test("every gated workflow has a gate job that only fork pull requests run, and builds when it is skipped", () => {
  const workflows = path.join(__dirname, "..", "workflows");
  const forkOnly = "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository";
  const buildsWhenSkipped = "needs.gate.result == 'skipped' || (needs.gate.result == 'success' && needs.gate.outputs.run == 'true')";
  for (const workflow of vouch.GATED_WORKFLOWS) {
    const text = fs.readFileSync(path.join(workflows, workflow), "utf8");
    const gateJob = text.match(/^  gate:\n((?:    .*\n|\n)*)/m);
    assert.ok(gateJob, `${workflow} has a gate job`);
    assert.ok(gateJob[1].includes(`    ${forkOnly}\n`), `${workflow}'s gate runs for fork pull requests only`);
    assert.ok(gateJob[1].includes("vouch.gate("), `${workflow}'s gate asks vouch.gate`);
    assert.ok(text.includes(buildsWhenSkipped), `${workflow} builds when its gate is skipped`);
    assert.ok(!/^    if: needs\.gate\.outputs\.run == 'true'$/m.test(text), `${workflow} has no job that a skipped gate would skip`);
    const runChecks = text.match(/[^\n]{0,40}needs\.gate\.outputs\.run == 'true'/g) || [];
    assert.ok(runChecks.length > 0, `${workflow} reads the gate's decision`);
    for (const check of runChecks) {
      assert.ok(check.endsWith("needs.gate.result == 'success' && needs.gate.outputs.run == 'true'"), `${workflow} trusts run only from a gate that succeeded: ${check}`);
    }
    for (const line of text.match(/^    if: .*needs\.gate\..*$/gm) || []) {
      assert.ok(line.startsWith("    if: ${{ !cancelled() && "), `${workflow}: ${line.trim()} starts with !cancelled()`);
    }
  }
});

test("the run-ci label re-runs that pull request's skipped build; other labels do nothing", async () => {
  const github = fakeGithub({ runs: { s9: [runOf(9, 900)] }, jobs: { 900: GATE_SKIPPED } });
  await invoke("run", {
    github,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "run-ci" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [900]);
  assert.deepEqual(github.named("issues.addLabels"), []);
  const other = fakeGithub({ runs: { s9: [runOf(9, 900)] }, jobs: { 900: GATE_SKIPPED } });
  await invoke("run", {
    github: other,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "bug" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(other.calls, []);
});

async function gateFor({ author, labels = [], attempt = 1, actor, permissions = {}, github: given }) {
  const github = given || fakeGithub({ permissions, pulls: [pr(42, author, { labels })] });
  const { core, result } = await invoke("gate", {
    github,
    eventName: "pull_request",
    payload: { pull_request: pr(42, author) },
    env: { GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_TRIGGERING_ACTOR: actor || author },
  });
  assert.equal(core.outputs.run, result.run ? "true" : "false");
  return { core, result };
}

test("the gate always passes on push", async () => {
  const github = fakeGithub();
  const { core } = await invoke("gate", { github, eventName: "push" });
  assert.equal(core.outputs.run, "true");
  assert.deepEqual(github.calls, []);
});

test("the gate passes trusted authors", async () => {
  for (const author of ["alice", "renovate[bot]", "owner"]) {
    const { result } = await gateFor({ author, permissions: { owner: "write" } });
    assert.equal(result.run, true, author);
  }
});

test("the gate skips an unvouched author and says how to start the build", async () => {
  const { result, core } = await gateFor({ author: "stranger" });
  assert.equal(result.run, false);
  assert.match(core.summaries[0], /run-ci/);
});

test("the gate passes an unvouched author's pull request labelled run-ci, read from the API", async () => {
  const { result } = await gateFor({ author: "stranger", labels: ["run-ci"] });
  assert.equal(result.run, true);
});

test("the gate passes a re-run started by a user with write or admin", async () => {
  for (const permission of ["write", "admin"]) {
    const { result } = await gateFor({ author: "stranger", attempt: 2, actor: "maint", permissions: { maint: permission } });
    assert.equal(result.run, true, permission);
  }
});

test("the gate skips a re-run by the unvouched author or by a user with read", async () => {
  const byAuthor = await gateFor({ author: "stranger", attempt: 2, actor: "stranger" });
  const byReader = await gateFor({ author: "stranger", attempt: 3, actor: "reader", permissions: { reader: "read" } });
  assert.equal(byAuthor.result.run, false);
  assert.equal(byReader.result.run, false);
});

test("the gate looks up the person who re-ran only when that decides the outcome", async () => {
  const cases = [
    { author: "alice", actor: "maint" },
    { author: "stranger", labels: ["run-ci"], actor: "maint" },
    { author: "stranger", actor: "github-actions[bot]" },
  ];
  for (const { author, labels = [], actor } of cases) {
    const github = fakeGithub({ permissions: { maint: "admin" }, pulls: [pr(42, author, { labels })] });
    await gateFor({ author, labels, attempt: 2, actor, github });
    const looked = github.named("repos.getCollaboratorPermissionLevel").map((call) => call.params.username);
    assert.ok(!looked.includes(actor), `${author} re-run by ${actor}`);
  }
});

test("the gate never passes a denounced author, even with run-ci or a maintainer re-run", async () => {
  const { result } = await gateFor({
    author: "mallory",
    labels: ["run-ci"],
    attempt: 2,
    actor: "maint",
    permissions: { mallory: "read", maint: "admin" },
  });
  assert.equal(result.run, false);
});

function facts(overrides = {}) {
  return {
    tier: "outsider",
    state: "open",
    createdAt: NEW,
    draft: false,
    body: SHOT,
    mergeable: "MERGEABLE",
    labels: [],
    linkedIssues: [{ number: 100, labels: ["bug"] }],
    position: 1,
    reviewThreads: [],
    checks: [],
    ...overrides,
  };
}

const { NOT_A_BUG_FIX, OVER_LIMIT, NEEDS_REBASE, READY, INCOMPLETE } = vouch;

test("rule decision: a complete bug fix from anyone outside the team is ready", () => {
  assert.deepEqual(vouch.ruleLabels(facts()), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ tier: "trusted" })), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ linkedIssues: [{ labels: ["Bug"] }, { labels: ["ui"] }] })), [READY]);
});

test("rule decision: the team, bots and denounced authors get no rule labels at all", () => {
  const broken = { draft: true, body: "", mergeable: "CONFLICTING", linkedIssues: [], position: 9 };
  for (const tier of ["team", "bot", "denounced"]) assert.equal(vouch.ruleLabels(facts({ ...broken, tier })), null, tier);
});

test("rule decision: before the cutover or once closed nothing is decided", () => {
  const broken = { draft: true, body: "", mergeable: "CONFLICTING", linkedIssues: [], position: 9 };
  assert.equal(vouch.ruleLabels(facts({ ...broken, createdAt: OLD })), null);
  assert.equal(vouch.ruleLabels(facts({ ...broken, createdAt: "2026-11-14T10:59:59Z" })), null);
  assert.equal(vouch.ruleLabels(facts({ ...broken, createdAt: undefined })), null);
  assert.deepEqual(vouch.ruleLabels(facts({ createdAt: vouch.RULES_START })), [READY]);
  assert.equal(vouch.ruleLabels(facts({ state: "closed" })), null);
});

test("rule decision: outsiders need a linked bug; trusted contributors may send features", () => {
  for (const linkedIssues of [[], [{ labels: [] }], [{ labels: ["enhancement"] }], undefined]) {
    assert.deepEqual(vouch.ruleLabels(facts({ linkedIssues })), [NOT_A_BUG_FIX, INCOMPLETE]);
    assert.deepEqual(vouch.ruleLabels(facts({ linkedIssues, tier: "trusted" })), [READY]);
  }
});

test("rule decision: an outsider's fourth open pull request is over the limit; trusted ones never are", () => {
  assert.equal(vouch.OPEN_PR_LIMIT, 3);
  assert.deepEqual(vouch.ruleLabels(facts({ position: 3 })), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ position: 4 })), [OVER_LIMIT, INCOMPLETE]);
  assert.deepEqual(vouch.ruleLabels(facts({ position: 7, linkedIssues: [] })), [NOT_A_BUG_FIX, OVER_LIMIT, INCOMPLETE]);
  assert.deepEqual(vouch.ruleLabels(facts({ position: 7, tier: "trusted" })), [READY]);
});

test("rule decision: a conflict needs a rebase for every ruled tier; unknown keeps the current label", () => {
  for (const tier of ["outsider", "trusted"]) {
    assert.deepEqual(vouch.ruleLabels(facts({ tier, mergeable: "CONFLICTING" })), [NEEDS_REBASE, INCOMPLETE], tier);
    assert.deepEqual(vouch.ruleLabels(facts({ tier, mergeable: "MERGEABLE", labels: [NEEDS_REBASE] })), [READY], tier);
  }
  assert.deepEqual(vouch.ruleLabels(facts({ mergeable: "UNKNOWN", labels: [NEEDS_REBASE] })), [NEEDS_REBASE, INCOMPLETE]);
  assert.deepEqual(vouch.ruleLabels(facts({ mergeable: "UNKNOWN", labels: [] })), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ mergeable: null, labels: [READY] })), [READY]);
});

test("rule decision: drafts, missing media and open bot review threads are incomplete", () => {
  for (const tier of ["outsider", "trusted"]) {
    assert.deepEqual(vouch.ruleLabels(facts({ tier, draft: true })), [INCOMPLETE]);
    assert.deepEqual(vouch.ruleLabels(facts({ tier, body: "Fixes the crash." })), [INCOMPLETE]);
    assert.deepEqual(vouch.ruleLabels(facts({ tier, reviewThreads: [{ resolved: false, startedByBot: true }] })), [INCOMPLETE]);
    assert.deepEqual(vouch.ruleLabels(facts({ tier, reviewThreads: [{ resolved: true, startedByBot: true }] })), [READY]);
    assert.deepEqual(vouch.ruleLabels(facts({ tier, reviewThreads: [{ resolved: false, startedByBot: false }] })), [READY]);
  }
});

test("rule decision: a finished failing check blocks ready; pending, passing and skipped ones do not", () => {
  for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "failure"]) {
    assert.deepEqual(vouch.ruleLabels(facts({ checks: [{ name: "app", conclusion }] })), [INCOMPLETE], conclusion);
  }
  for (const conclusion of [null, "SUCCESS", "SKIPPED", "NEUTRAL", "PENDING", "EXPECTED"]) {
    assert.deepEqual(vouch.ruleLabels(facts({ checks: [{ name: "app", conclusion }] })), [READY], String(conclusion));
  }
  assert.deepEqual(vouch.ruleLabels(facts({ checks: [{ name: vouch.BUG_FIX_STATUS_CONTEXT, conclusion: "FAILURE" }] })), [INCOMPLETE]);
});

test("rule decision: exactly one of ready and incomplete, always", () => {
  const variants = [
    {},
    { draft: true },
    { body: "" },
    { mergeable: "CONFLICTING" },
    { linkedIssues: [] },
    { position: 4 },
    { checks: [{ name: "x", conclusion: "FAILURE" }] },
    { reviewThreads: [{ resolved: false, startedByBot: true }] },
  ];
  for (const tier of ["outsider", "trusted"]) {
    for (const variant of variants) {
      const labels = vouch.ruleLabels(facts({ ...variant, tier }));
      assert.equal(labels.filter((name) => name === READY || name === INCOMPLETE).length, 1);
    }
  }
});

test("media in the description: images, videos, attachments and media links, not other links", () => {
  for (const body of [
    SHOT,
    "<img src=x>",
    "<video src=y></video>",
    "https://github.com/user-attachments/assets/1234-abcd",
    "see https://example.com/clip.MP4 here",
    "(https://i.imgur.com/a.png?raw=1)",
    "Before: https://example.com/before.gif. After: https://example.com/after.webm",
  ]) {
    assert.ok(vouch.hasMedia(body), body);
  }
  for (const body of ["", null, "https://example.com/page", "a png file", "<!-- ![x](y.png) -->", "https://example.com/a.pngx"]) {
    assert.ok(!vouch.hasMedia(body), String(body));
  }
});

test("a review bot's block in the description is not the author's media", () => {
  const greptile = [
    "<!-- greptile_comment -->",
    "<!-- greptile_summary -->",
    '<h2><a href="https://app.greptile.com/api/retrigger?id=1"><picture><img alt="Retrigger" src="https://greptile-static-assets.s3.amazonaws.com/badges/Retrigger.svg?v=2"></picture></a>Confidence Score: 5/5</h2>',
    "<!-- greptile_confidence_score:5 -->",
    "<!-- /greptile_comment -->",
  ].join("\n\n");
  const coderabbit = [
    "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
    "![walkthrough](https://example.com/diagram.png)",
    "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
  ].join("\n");
  const words = "Closes #5\n\n## Verification (screenshots and videos)\n\nRan the check, it passes.";
  assert.ok(!vouch.hasMedia(`${words}\n\n${greptile}`));
  assert.ok(!vouch.hasMedia(`${words}\n\n${coderabbit}`));
  assert.ok(!vouch.hasMedia(`${words}\n\n<!-- greptile_comment -->\n<img src=x>`));
  assert.ok(vouch.hasMedia(`${words}\n\n${SHOT}\n\n${greptile}`));
  assert.ok(vouch.hasMedia(`${greptile}\n\n${coderabbit}\n\n${SHOT}`));
});

test("closing references use linked-issue.yml's rule", () => {
  assert.deepEqual(vouch.closingIssueNumbers("Closes #12, fixes: #3\nResolved #12\nFIXED #40"), [3, 12, 40]);
  assert.deepEqual(vouch.closingIssueNumbers("prefixes #5 and closes#6 and refs #7 and fix\n#8"), []);
});

test("open positions are per author in creation order", () => {
  const positions = vouch.openPositions([
    { number: 9, login: "a", createdAt: "2026-11-15T03:00:00Z" },
    { number: 4, login: "A", createdAt: "2026-11-15T01:00:00Z" },
    { number: 7, login: "b", createdAt: "2026-11-15T00:00:00Z" },
    { number: 5, login: "a", createdAt: "2026-11-15T02:00:00Z" },
  ]);
  assert.deepEqual(Object.fromEntries(positions), { 4: 1, 5: 2, 9: 3, 7: 1 });
});

test("only the newest run of each check counts", () => {
  const checks = vouch.latestChecks([
    { key: "Linked issue/linked-issue", name: "linked-issue", conclusion: "FAILURE", startedAt: "2026-11-15T01:00:00Z" },
    { key: "Linked issue/linked-issue", name: "linked-issue", conclusion: "SUCCESS", startedAt: "2026-11-15T02:00:00Z" },
    { key: "Vouch/vouch", name: "vouch", conclusion: "CANCELLED", startedAt: "2026-11-15T01:00:00Z" },
    { key: "Vouch/vouch", name: "vouch", conclusion: null, startedAt: null },
  ]);
  assert.deepEqual(checks, [{ name: "linked-issue", conclusion: "SUCCESS" }, { name: "vouch", conclusion: null }]);
});

test("the bug-fix-only status: failure only for an outsider's non-bug-fix", () => {
  assert.equal(vouch.bugFixStatus("outsider", [NOT_A_BUG_FIX, INCOMPLETE]).state, "failure");
  assert.ok(vouch.bugFixStatus("outsider", [NOT_A_BUG_FIX]).description.length <= 140);
  assert.equal(vouch.bugFixStatus("outsider", [READY]).state, "success");
  assert.equal(vouch.bugFixStatus("trusted", [READY]).state, "success");
  assert.equal(vouch.bugFixStatus("outsider", null), null);
});

const BUG = pr(100, "reporter", { labels: ["bug"] });
const FEATURE = pr(101, "reporter", { labels: ["enhancement"] });

function ruleWrites(github) {
  return github.calls
    .filter((call) => ["issues.addLabels", "issues.removeLabel", "repos.createCommitStatus"].includes(call.name))
    .filter((call) => call.name !== "issues.addLabels" || !call.params.labels.some((name) => name.startsWith("vouch:")))
    .filter((call) => call.name !== "issues.removeLabel" || !call.params.name.startsWith("vouch:"))
    .map(({ name, params }) => {
      if (name === "repos.createCommitStatus") return ["status", params.sha, params.state];
      if (name === "issues.addLabels") return ["add", params.issue_number, ...params.labels];
      return ["remove", params.issue_number, params.name];
    });
}

async function event(github, action, pull, extra = {}) {
  const payload = { action, pull_request: { ...pull, created_at: pull.rules.created_at }, ...extra };
  return invoke("run", { github, eventName: "pull_request_target", payload });
}

test("a new outsider pull request that closes no bug gets the labels, a failing status and stays open", async () => {
  const pull = fresh(50, "stranger", { linked: [101] });
  const github = fakeGithub({ pulls: [pull], issues: [BUG, FEATURE] });
  await event(github, "opened", pull);
  assert.deepEqual(ruleWrites(github), [["add", 50, NOT_A_BUG_FIX, INCOMPLETE], ["status", "sha50", "failure"]]);
  const [status] = github.named("repos.createCommitStatus");
  assert.equal(status.params.context, "bug-fix-only");
  assert.equal(status.params.target_url, "https://github.com/acme/ardia/blob/main/CONTRIBUTING.md#pull-requests");
  assert.match(status.params.description, /bug fixes only/);
  assert.deepEqual(github.named("pulls.update"), []);
  assert.equal(github.named("issues.createComment").length, 1);
});

test("a complete outsider bug fix is ready with a passing status", async () => {
  const pull = fresh(51, "stranger");
  const github = fakeGithub({ pulls: [pull], issues: [BUG] });
  await event(github, "synchronize", pull);
  assert.deepEqual(ruleWrites(github), [["add", 51, READY], ["status", "sha51", "success"]]);
});

test("a pull request from before the cutover is never touched, even when it breaks every rule", async () => {
  const pull = pr(52, "stranger", {
    created_at: OLD,
    labels: [vouch.UNVOUCHED, READY],
    draft: true,
    mergeable: "CONFLICTING",
    linked: [],
    checks: [{ __typename: "CheckRun", name: "app", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const github = fakeGithub({ pulls: [pull] });
  for (const action of ["edited", "synchronize", "ready_for_review", "converted_to_draft", "reopened"]) {
    await event(github, action, pull);
  }
  await invoke("run", {
    github,
    eventName: "issue_comment",
    payload: { action: "created", comment: { body: "/recheck" }, issue: { ...pull, created_at: OLD, pull_request: {} } },
  });
  await invoke("run", { github, eventName: "schedule" });
  assert.deepEqual(ruleWrites(github), []);
  assert.deepEqual(github.named("graphql.VouchRulePull"), []);
});

test("old pull requests still count toward an author's open total", async () => {
  const old = [1, 2, 3].map((number) => pr(number, "stranger", { created_at: `2026-11-0${number}T00:00:00Z` }));
  const pull = fresh(60, "stranger");
  const github = fakeGithub({ pulls: [...old, pull], issues: [BUG] });
  await event(github, "opened", pull);
  assert.deepEqual(ruleWrites(github), [["add", 60, OVER_LIMIT, INCOMPLETE], ["status", "sha60", "success"]]);
});

test("the team and bots get no rule labels and no status, whatever they send", async () => {
  for (const login of ["shivamhwp", "MantraKP04", "renovate[bot]"]) {
    const pull = fresh(61, login, { linked: [], draft: true, mergeable: "CONFLICTING", body: "" });
    const github = fakeGithub({ pulls: [pull], permissions: { shivamhwp: "admin", MantraKP04: "write" } });
    await event(github, "opened", pull);
    await event(github, "edited", pull);
    await invoke("run", { github, eventName: "schedule" });
    assert.deepEqual(ruleWrites(github), [], login);
    assert.deepEqual(github.named("issues.createComment"), [], login);
  }
});

test("a denounced author's new pull request is closed as before and gets no rule labels", async () => {
  const pull = fresh(62, "mallory", { linked: [] });
  const github = fakeGithub({ permissions: { mallory: "read" }, pulls: [pull] });
  await event(github, "opened", pull);
  assert.deepEqual(github.named("pulls.update").map((call) => call.params.pull_number), [62]);
  assert.deepEqual(ruleWrites(github), []);
});

test("a trusted contributor's feature is fine, but a conflict still needs a rebase; no status is set", async () => {
  const feature = fresh(63, "alice", { linked: [101] });
  const conflicting = fresh(64, "alice", { linked: [], mergeable: "CONFLICTING" });
  const github = fakeGithub({ pulls: [feature, conflicting], issues: [FEATURE] });
  await event(github, "edited", feature);
  await event(github, "edited", conflicting);
  assert.deepEqual(ruleWrites(github), [["add", 63, READY], ["add", 64, NEEDS_REBASE, INCOMPLETE]]);
});

test("a vouched author's leftover failing status turns to success", async () => {
  const pull = fresh(65, "alice", {
    linked: [101],
    labels: [NOT_A_BUG_FIX, INCOMPLETE],
    bugFix: { state: "FAILURE", description: "old", targetUrl: "x" },
  });
  const github = fakeGithub({ pulls: [pull], issues: [FEATURE] });
  await event(github, "edited", pull);
  assert.deepEqual(ruleWrites(github), [
    ["add", 65, READY],
    ["remove", 65, NOT_A_BUG_FIX],
    ["remove", 65, INCOMPLETE],
    ["status", "sha65", "success"],
  ]);
});

function stranglerFixture({ commented = false } = {}) {
  const pulls = [1, 2, 3, 4].map((index) =>
    fresh(70 + index, "stranger", { created_at: `2026-11-15T0${index}:00:00Z`, labels: index === 4 ? [] : [READY] }),
  );
  const comments = commented ? { 74: [{ body: "@stranger, more than 3 open, see acme/ardia on main." }] } : {};
  return { pulls, github: fakeGithub({ pulls, issues: [BUG], comments }) };
}

test("the over-limit note is posted once, with the limit filled in", async () => {
  const { pulls, github } = stranglerFixture();
  await event(github, "opened", pulls[3]);
  const notes = github.named("issues.createComment").map((call) => [call.params.issue_number, call.params.body]);
  assert.deepEqual(notes, [
    [74, "Hi @stranger, see acme/ardia on main."],
    [74, "@stranger, more than 3 open, see acme/ardia on main."],
  ]);
  assert.ok(ruleWrites(github).some((write) => write[0] === "add" && write[1] === 74 && write.includes(OVER_LIMIT)));
  const again = stranglerFixture({ commented: true });
  await event(again.github, "reopened", again.pulls[3]);
  assert.deepEqual(again.github.named("issues.createComment"), []);
  const labelled = stranglerFixture();
  labelled.pulls[3].labels = [{ name: OVER_LIMIT }, { name: INCOMPLETE }, { name: vouch.UNVOUCHED }];
  await event(labelled.github, "synchronize", labelled.pulls[3]);
  assert.deepEqual(labelled.github.named("issues.createComment"), []);
  assert.deepEqual(ruleWrites(labelled.github), [["status", "sha74", "success"]]);
});

test("closing one pull request takes over-limit off the author's next one", async () => {
  const { pulls, github } = stranglerFixture();
  pulls[3].labels = [{ name: OVER_LIMIT }, { name: INCOMPLETE }];
  for (const pull of pulls.slice(0, 3)) pull.rules.bugFix = { state: "SUCCESS", description: "A linked issue is labelled bug", targetUrl: "https://github.com/acme/ardia/blob/main/CONTRIBUTING.md#pull-requests" };
  pulls[3].rules.bugFix = pulls[0].rules.bugFix;
  pulls[0].state = "closed";
  await event(github, "closed", pulls[0]);
  assert.deepEqual(ruleWrites(github), [["add", 74, READY], ["remove", 74, OVER_LIMIT], ["remove", 74, INCOMPLETE]]);
  assert.ok(github.named("graphql.VouchRulePull").every((call) => call.params.number !== 71));
});

test("reopening an old pull request pushes a newer one over the limit", async () => {
  const pulls = [
    pr(1, "stranger", { created_at: OLD }),
    fresh(2, "stranger", { created_at: "2026-11-15T01:00:00Z", labels: [READY] }),
    fresh(3, "stranger", { created_at: "2026-11-15T02:00:00Z", labels: [READY] }),
    fresh(4, "stranger", { created_at: "2026-11-15T03:00:00Z", labels: [READY] }),
  ];
  const github = fakeGithub({ pulls, issues: [BUG] });
  await event(github, "reopened", pulls[0]);
  assert.ok(ruleWrites(github).some((write) => write[0] === "add" && write[1] === 4 && write.includes(OVER_LIMIT)));
  assert.ok(!ruleWrites(github).some((write) => write[1] === 1));
});

test("the status is written only when it changes", async () => {
  const url = "https://github.com/acme/ardia/blob/main/CONTRIBUTING.md#pull-requests";
  const same = fresh(80, "stranger", {
    labels: [READY],
    bugFix: { state: "SUCCESS", description: "A linked issue is labelled bug", targetUrl: url },
  });
  const github = fakeGithub({ pulls: [same], issues: [BUG] });
  await event(github, "edited", same);
  assert.deepEqual(github.writes(), []);
  const stale = fresh(81, "stranger", { labels: [READY], bugFix: { state: "FAILURE", description: "x", targetUrl: url } });
  const other = fakeGithub({ pulls: [stale], issues: [BUG] });
  await event(other, "edited", stale);
  assert.deepEqual(ruleWrites(other), [["status", "sha81", "success"]]);
});

test("an unknown mergeable state is asked again, and when it stays unknown the label is kept", async () => {
  const settling = fresh(90, "stranger", { mergeable: ["UNKNOWN", "UNKNOWN", "CONFLICTING"] });
  const github = fakeGithub({ pulls: [settling], issues: [BUG] });
  await event(github, "synchronize", settling);
  assert.equal(github.named("graphql.VouchMergeable").length, 2);
  assert.deepEqual(ruleWrites(github)[0], ["add", 90, NEEDS_REBASE, INCOMPLETE]);
  const stuck = fresh(91, "stranger", { mergeable: "UNKNOWN", labels: [NEEDS_REBASE, INCOMPLETE] });
  const stuckGithub = fakeGithub({ pulls: [stuck], issues: [BUG] });
  await event(stuckGithub, "synchronize", stuck);
  assert.equal(stuckGithub.named("graphql.VouchMergeable").length, 3);
  assert.deepEqual(ruleWrites(stuckGithub), [["status", "sha91", "success"]]);
  const clean = fresh(92, "stranger", { mergeable: "UNKNOWN" });
  const cleanGithub = fakeGithub({ pulls: [clean], issues: [BUG] });
  await event(cleanGithub, "synchronize", clean);
  assert.deepEqual(ruleWrites(cleanGithub)[0], ["add", 92, READY]);
});

test("open bot review threads and failing head checks keep a pull request incomplete", async () => {
  const pull = fresh(93, "stranger", {
    threads: [{ by: "coderabbitai[bot]" }, { by: "alice" }],
    checks: [
      { __typename: "CheckRun", name: "linked-issue", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-15T01:00:00Z", checkSuite: { workflowRun: { workflow: { name: "Linked issue" } } } },
      { __typename: "CheckRun", name: "linked-issue", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-15T02:00:00Z", checkSuite: { workflowRun: { workflow: { name: "Linked issue" } } } },
      { __typename: "CheckRun", name: "app", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-15T02:00:00Z" },
    ],
  });
  const github = fakeGithub({ pulls: [pull], issues: [BUG] });
  await event(github, "edited", pull);
  assert.deepEqual(ruleWrites(github)[0], ["add", 93, INCOMPLETE]);
  pull.rules.threads = [{ by: "coderabbitai[bot]", resolved: true }];
  const again = fakeGithub({ pulls: [pull], issues: [BUG] });
  await event(again, "edited", pull);
  assert.deepEqual(ruleWrites(again)[0], ["add", 93, READY]);
  pull.rules.checks.push({ __typename: "StatusContext", context: "ci/legacy", state: "ERROR", createdAt: "2026-11-15T02:00:00Z" });
  const failed = fakeGithub({ pulls: [pull], issues: [BUG] });
  await event(failed, "edited", pull);
  assert.deepEqual(ruleWrites(failed)[0], ["add", 93, INCOMPLETE]);
});

test("on a base other than the default branch, the description's closing references are read", async () => {
  const pull = fresh(94, "stranger", { base: "release", linked: [], body: `Fixes #100, closes #7\n${SHOT}` });
  const issues = [BUG, { ...pr(7, "x"), pull_request: {}, labels: [{ name: "bug" }] }];
  const github = fakeGithub({ pulls: [pull], issues });
  await event(github, "edited", pull);
  assert.deepEqual(ruleWrites(github)[0], ["add", 94, READY]);
  const notABug = fresh(95, "stranger", { base: "release", linked: [], body: `Fixes #7\n${SHOT}` });
  const other = fakeGithub({ pulls: [notABug], issues });
  await event(other, "edited", notABug);
  assert.deepEqual(ruleWrites(other)[0], ["add", 95, NOT_A_BUG_FIX, INCOMPLETE]);
  const onMain = fresh(96, "stranger", { linked: [], body: `Fixes #100\n${SHOT}` });
  const main = fakeGithub({ pulls: [onMain], issues });
  await event(main, "edited", onMain);
  assert.deepEqual(ruleWrites(main)[0], ["add", 96, NOT_A_BUG_FIX, INCOMPLETE]);
  assert.deepEqual(main.named("issues.get"), []);
});

test("labelling an issue bug re-evaluates the open pull requests that close it", async () => {
  const issue = pr(100, "reporter", { labels: ["bug"] });
  const linked = fresh(97, "stranger", { linked: [100], labels: [NOT_A_BUG_FIX, INCOMPLETE] });
  const closed = fresh(98, "stranger", { linked: [100], state: "closed", labels: [NOT_A_BUG_FIX] });
  const old = pr(99, "stranger", { created_at: OLD, linked: [100], labels: [INCOMPLETE] });
  const github = fakeGithub({ pulls: [linked, closed, old], issues: [issue] });
  await invoke("run", { github, eventName: "issues", payload: { action: "labeled", label: { name: "bug" }, issue } });
  assert.deepEqual(ruleWrites(github), [
    ["add", 97, READY],
    ["remove", 97, NOT_A_BUG_FIX],
    ["remove", 97, INCOMPLETE],
    ["status", "sha97", "success"],
  ]);
  const unlabel = fakeGithub({ pulls: [fresh(97, "stranger", { linked: [100], labels: [READY] })], issues: [pr(100, "reporter")] });
  await invoke("run", { github: unlabel, eventName: "issues", payload: { action: "unlabeled", label: { name: "Bug" }, issue: pr(100, "reporter") } });
  assert.deepEqual(ruleWrites(unlabel), [["add", 97, NOT_A_BUG_FIX, INCOMPLETE], ["remove", 97, READY], ["status", "sha97", "failure"]]);
  const otherLabel = fakeGithub({ pulls: [linked], issues: [issue] });
  await invoke("run", { github: otherLabel, eventName: "issues", payload: { action: "labeled", label: { name: "ui" }, issue } });
  assert.deepEqual(otherLabel.calls, []);
});

test("/recheck evaluates the rules of that pull request", async () => {
  const pull = fresh(110, "stranger", { linked: [], labels: [vouch.UNVOUCHED] });
  const github = fakeGithub({ pulls: [pull] });
  await invoke("run", {
    github,
    eventName: "issue_comment",
    payload: { action: "created", comment: { body: "/recheck" }, issue: { ...pull, created_at: NEW, pull_request: {} } },
  });
  assert.deepEqual(ruleWrites(github), [["add", 110, NOT_A_BUG_FIX, INCOMPLETE], ["status", "sha110", "failure"]]);
});

function ruleSweepFixture() {
  const pulls = [];
  for (let index = 0; index < 30; index += 1) {
    const created = new Date(Date.parse(NEW) + index * 60000).toISOString();
    pulls.push(fresh(200 + index, `person${index}`, { created_at: created, labels: [READY] }));
  }
  pulls.push(fresh(300, "stranger", { linked: [] }));
  pulls.push(pr(301, "stranger", { created_at: OLD, linked: [], labels: [READY] }));
  pulls.push(fresh(302, "stranger", { state: "closed", linked: [] }));
  return fakeGithub({ pulls, issues: [BUG] });
}

test("the sweep pages through new open pull requests 25 at a time and fixes their rule labels", async () => {
  const github = ruleSweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "schedule" });
  const pages = github.named("graphql.VouchRulePulls");
  assert.deepEqual(pages.map((call) => [call.params.first, call.params.after]), [[25, null], [25, "25"]]);
  const touched = new Set(ruleWrites(github).map((write) => write[1]));
  assert.ok(touched.has(300) && !touched.has(301) && !touched.has(302));
  assert.deepEqual(result.rules.find((change) => change.number === 300).add, [NOT_A_BUG_FIX, INCOMPLETE]);
  assert.match(core.summaries[0], /pull request #300: \+not-a-bug-fix \+incomplete status failure/);
  assert.match(core.summaries[0], /\| `ready` \| 30 \|/);
});

test("a dry-run sweep writes no rule labels, statuses or notes but reports them", async () => {
  const github = ruleSweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "workflow_dispatch", payload: { inputs: { dry_run: "true" } } });
  assert.deepEqual(github.writes(), []);
  assert.equal(github.named("issues.listComments").length, 0);
  assert.ok(result.rules.length >= 31);
  assert.match(core.summaries[0], /Would change \(\d+\)/);
});

test("the sweep never strips hand-applied labels from old pull requests", async () => {
  const github = fakeGithub({
    pulls: [pr(400, "stranger", { created_at: OLD, labels: [vouch.UNVOUCHED, READY, INCOMPLETE], mergeable: "CONFLICTING" })],
  });
  await invoke("run", { github, eventName: "schedule" });
  assert.deepEqual(github.writes(), []);
});

test("listChanged, run by the vouch command, checks the rules in the same run", async () => {
  const github = ruleSweepFixture();
  const { result } = await invoke("listChanged", { github, eventName: "issue_comment" });
  assert.ok(github.named("graphql.VouchRulePulls").length > 0);
  assert.ok(result.rules.length > 0);
});

test("our own stale bug-fix-only status never blocks ready, but a check run with that name does", async () => {
  const stale = { __typename: "StatusContext", context: "bug-fix-only", state: "FAILURE", createdAt: "2026-11-15T02:00:00Z" };
  const pull = fresh(95, "stranger", { checks: [stale], bugFix: { state: "FAILURE", description: "old", targetUrl: "" } });
  const github = fakeGithub({ pulls: [pull], issues: [BUG] });
  await event(github, "edited", pull);
  assert.deepEqual(ruleWrites(github), [["add", 95, READY], ["status", "sha95", "success"]]);
  const lookalike = { __typename: "CheckRun", name: "bug-fix-only", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-15T02:00:00Z" };
  const other = fresh(96, "stranger", { checks: [lookalike] });
  const second = fakeGithub({ pulls: [other], issues: [BUG] });
  await event(second, "edited", other);
  assert.deepEqual(ruleWrites(second)[0], ["add", 96, INCOMPLETE]);
});

test("a team member with no write access is trusted: no note, and the gate lets the build run", async () => {
  const pull = fresh(97, "shivamhwp", { linked: [] });
  const github = fakeGithub({ pulls: [pull] });
  await event(github, "opened", pull);
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.TRUSTED]]);
  assert.deepEqual(github.named("issues.createComment"), []);
  const { result } = await gateFor({ author: "shivamhwp" });
  assert.equal(result.run, true);
});

test("the sweep reads a pull request again before it writes, so a change made meanwhile wins", async () => {
  const pull = fresh(98, "stranger", { linked: [101] });
  const issues = [BUG, { ...FEATURE, labels: [...FEATURE.labels] }];
  const github = fakeGithub({ pulls: [pull], issues });
  const graphql = github.graphql;
  github.graphql = async (query, variables) => {
    const answer = await graphql(query, variables);
    if (/query VouchRulePulls/.test(query)) issues[1].labels.push({ name: "bug" });
    return answer;
  };
  await invoke("run", { github, eventName: "schedule" });
  assert.equal(github.named("graphql.VouchRulePull").length, 1);
  assert.deepEqual(ruleWrites(github), [["add", 98, READY], ["status", "sha98", "success"]]);
});

const { ALREADY_CLAIMED } = vouch;
const DAY = 24 * 60 * 60 * 1000;
const CLAIM_CALLS = ["issues.addAssignees", "issues.removeAssignees", "reactions.createForIssueComment", "graphql.VouchMinimize", "issues.createComment"];

function claimIssue(number, { labels = ["bug"], ...options } = {}) {
  return pr(number, "reporter", { labels, ...options });
}

function comment(id, login, body, createdAt = CLAIMED, extra = {}) {
  return { id, node_id: `IC_${id}`, user: { login }, body, created_at: createdAt, ...extra };
}

function claimWrites(github) {
  return github.calls
    .filter((call) => CLAIM_CALLS.includes(call.name))
    .map(({ name, params }) => {
      if (name === "issues.addAssignees") return ["assign", params.issue_number, ...params.assignees];
      if (name === "issues.removeAssignees") return ["unassign", params.issue_number, ...params.assignees];
      if (name === "reactions.createForIssueComment") return ["react", params.comment_id, params.content];
      if (name === "graphql.VouchMinimize") return ["minimize", params.id, params.classifier];
      return ["reply", params.issue_number, params.body];
    });
}

async function command(github, issue, body = "/take") {
  return invoke("run", { github, eventName: "issue_comment", payload: { action: "created", comment: { body }, issue } });
}

function heldIssue(overrides = {}) {
  return { number: 120, state: "open", labels: ["bug"], assignees: [], pulls: [], ...overrides };
}

test("who holds an issue: its assignees first, else the earliest open pull request's author, never a bot", () => {
  const pulls = [
    { number: 131, createdAt: "2026-11-17T10:00:00Z", login: "bob" },
    { number: 130, createdAt: "2026-11-17T09:00:00Z", login: "carol" },
  ];
  assert.deepEqual(vouch.issueHolder(heldIssue({ pulls })), { logins: ["carol"], pull: 130 });
  assert.deepEqual(vouch.issueHolder(heldIssue({ pulls, assignees: ["alice"] })), { logins: ["alice"], pull: null });
  assert.deepEqual(vouch.issueHolder(heldIssue({ pulls: [{ number: 132, createdAt: CLAIMED, login: null }, ...pulls] })).logins, ["carol"]);
  assert.equal(vouch.issueHolder(heldIssue()), null);
  assert.equal(vouch.issueHolder(heldIssue({ state: "closed", assignees: ["alice"], pulls })), null);
  const twice = [{ number: 141, createdAt: "2026-11-17T11:00:00Z", login: "Carol" }, ...pulls.slice(1)];
  assert.deepEqual(vouch.issueHolder(heldIssue({ pulls: twice })), { logins: ["carol"], pull: 130 });
  assert.equal(vouch.takeDecision({ login: "CAROL", tier: "outsider", issue: heldIssue({ pulls: twice }) }).outcome, "assign");
});

test("a command is exactly /take or /drop, trimmed and in any case", () => {
  assert.equal(vouch.claimCommand(" /TAKE \n"), "/take");
  assert.equal(vouch.claimCommand("/drop"), "/drop");
  for (const body of ["/take please", "/takes", "take", "", null, "> /take"]) assert.equal(vouch.claimCommand(body), null, String(body));
});

test("take decision: someone else's hold first, then the outsider's bug rule and cap; trusted and team have neither", () => {
  const free = heldIssue({ labels: [] });
  assert.equal(vouch.takeDecision({ login: "x", tier: "outsider", issue: heldIssue({ assignees: ["alice"] }) }).outcome, "taken");
  assert.equal(vouch.takeDecision({ login: "alice", tier: "outsider", issue: heldIssue({ assignees: ["Alice"], labels: [] }) }).outcome, "kept");
  assert.equal(vouch.takeDecision({ login: "x", tier: "outsider", issue: free }).outcome, "not-a-bug");
  assert.equal(vouch.takeDecision({ login: "x", tier: "outsider", issue: heldIssue(), held: 2 }).outcome, "assign");
  assert.equal(vouch.takeDecision({ login: "x", tier: "outsider", issue: heldIssue(), held: 3 }).outcome, "at-limit");
  for (const tier of ["trusted", "team"]) assert.equal(vouch.takeDecision({ login: "x", tier, issue: free, held: 9 }).outcome, "assign", tier);
  assert.equal(vouch.dropDecision({ login: "ALICE", issue: heldIssue({ assignees: ["alice"] }) }).outcome, "release");
  assert.equal(vouch.dropDecision({ login: "bob", issue: heldIssue({ assignees: ["alice"], pulls: [{ number: 1, createdAt: CLAIMED, login: "bob" }] }) }).outcome, "refuse");
});

test("stale decision: more than five quiet days with no open pull request, counted from the newest sign of life", () => {
  assert.equal(vouch.CLAIM_QUIET_DAYS, 5);
  const at = Date.parse("2026-11-20T00:00:00Z");
  const thread = { assignedEvents: [{ login: "a", createdAt: "2026-11-20T00:00:00Z" }], comments: [], everyPull: [] };
  assert.equal(vouch.claimIsStale(thread, "a", at + 5 * DAY - 1), false);
  assert.equal(vouch.claimIsStale(thread, "a", at + 5 * DAY), false);
  assert.equal(vouch.claimIsStale(thread, "A", at + 5 * DAY + 1), true);
  const commented = { ...thread, comments: [{ login: "a", createdAt: "2026-11-23T00:00:00Z" }, { login: "b", createdAt: "2026-11-24T00:00:00Z" }] };
  assert.equal(vouch.claimLastActive(commented, "a"), Date.parse("2026-11-23T00:00:00Z"));
  assert.equal(vouch.claimIsStale(commented, "a", at + 7 * DAY), false);
  assert.equal(vouch.claimIsStale(commented, "a", at + 8 * DAY + 1), true);
  const pulling = { ...thread, everyPull: [{ login: "a", state: "open", createdAt: "2026-11-20T01:00:00Z" }] };
  assert.equal(vouch.claimIsStale(pulling, "a", at + 60 * DAY), false);
  const closedPull = { ...thread, everyPull: [{ login: "a", state: "closed", closedAt: "2026-11-24T00:00:00Z" }, { login: "b", state: "open" }] };
  assert.equal(vouch.claimIsStale(closedPull, "a", at + 8 * DAY), false);
  assert.equal(vouch.claimIsStale(closedPull, "a", at + 9 * DAY + 1), true);
  const beyondThePage = { ...thread, pulls: [{ number: 150, login: "a", createdAt: "2026-11-20T01:00:00Z" }], everyPull: [{ login: "b", state: "closed", closedAt: "2026-11-19T00:00:00Z" }] };
  assert.equal(vouch.claimIsStale(beyondThePage, "a", at + 60 * DAY), false);
  const start = Date.parse(vouch.CLAIMS_START);
  const preRule = { assignedEvents: [{ login: "a", createdAt: "2026-11-01T00:00:00Z" }], comments: [], everyPull: [] };
  assert.equal(vouch.claimIsStale(preRule, "a", start + 5 * DAY - 1), false);
  assert.equal(vouch.claimIsStale(preRule, "a", start + 5 * DAY + 1), true);
});

test("/take on a free bug assigns the commenter, thumbs up, minimizes and re-checks the issue's pull requests", async () => {
  const issue = claimIssue(120);
  const github = fakeGithub({ issues: [issue], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [["assign", 120, "stranger"], ["react", 1, "+1"], ["minimize", "IC_1", "RESOLVED"]]);
  assert.equal(github.named("graphql.VouchIssuePulls").length, 1);
});

test("/take on an issue someone is assigned to is refused with one reply naming them", async () => {
  const issue = claimIssue(120, { assignees: ["alice"] });
  const github = fakeGithub({ issues: [issue], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [
    ["react", 1, "-1"],
    ["reply", 120, "@alice is already working on this."],
    ["minimize", "IC_1", "RESOLVED"],
  ]);
});

test("/take on an issue held by an earlier pull request names that pull request; the commenter's own pull request lets them take it", async () => {
  const issue = claimIssue(120);
  const pulls = [fresh(131, "bob", { created_at: "2026-11-17T10:00:00Z", linked: [120] }), fresh(130, "alice", { created_at: CLAIMED, linked: [120] })];
  const github = fakeGithub({ issues: [issue], pulls, comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(github, issue);
  assert.deepEqual(claimWrites(github)[1], ["reply", 120, "@alice is already working on this in #130."]);
  const own = claimIssue(120);
  const mine = fakeGithub({ issues: [own], pulls: [fresh(130, "stranger", { created_at: CLAIMED, linked: [120] })], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(mine, own);
  assert.deepEqual(claimWrites(mine).slice(0, 2), [["assign", 120, "stranger"], ["react", 1, "+1"]]);
});

test("an outsider's /take needs a bug and stays under the cap; a trusted contributor or the team needs neither", async () => {
  const feature = claimIssue(120, { labels: [] });
  const notABug = fakeGithub({ issues: [feature], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(notABug, feature);
  assert.deepEqual(claimWrites(notABug), [
    ["react", 1, "-1"],
    ["reply", 120, "@stranger, bug fixes only, see acme/ardia on main."],
    ["minimize", "IC_1", "RESOLVED"],
  ]);
  const others = (login) => [121, 122, 123].map((number) => claimIssue(number, { assignees: [login] }));
  const bug = claimIssue(120);
  const capped = fakeGithub({ issues: [bug, ...others("stranger")], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(capped, bug);
  assert.deepEqual(claimWrites(capped), [["react", 1, "-1"], ["reply", 120, "@stranger, you hold 3 issues already."], ["minimize", "IC_1", "RESOLVED"]]);
  const underCap = fakeGithub({ issues: [claimIssue(120), ...others("stranger").slice(1)], comments: { 120: [comment(1, "stranger", "/take")] } });
  await command(underCap, claimIssue(120));
  assert.deepEqual(claimWrites(underCap)[0], ["assign", 120, "stranger"]);
  for (const login of ["alice", "shivamhwp"]) {
    const trustedIssue = claimIssue(120, { labels: [] });
    const github = fakeGithub({ issues: [trustedIssue, ...others(login)], comments: { 120: [comment(1, login, "/take")] } });
    await command(github, trustedIssue);
    assert.deepEqual(claimWrites(github), [["assign", 120, login], ["react", 1, "+1"], ["minimize", "IC_1", "RESOLVED"]], login);
  }
});

test("/drop by the assignee releases the issue and retires the reply that named them; anyone else's /drop gets a thumbs down", async () => {
  const issue = claimIssue(120, { assignees: ["stranger"] });
  const github = fakeGithub({
    issues: [issue],
    comments: { 120: [comment(5, "github-actions[bot]", "@stranger is already working on this.", "2026-11-17T08:00:00Z"), comment(6, "stranger", "/drop")] },
  });
  await command(github, issue, "/drop");
  assert.deepEqual(claimWrites(github), [
    ["unassign", 120, "stranger"],
    ["react", 6, "+1"],
    ["minimize", "IC_6", "RESOLVED"],
    ["minimize", "IC_5", "OUTDATED"],
  ]);
  const held = claimIssue(120, { assignees: ["alice"] });
  const stranger = fakeGithub({ issues: [held], comments: { 120: [comment(7, "bob", "/drop")] } });
  await command(stranger, held, "/drop");
  assert.deepEqual(claimWrites(stranger), [["react", 7, "-1"], ["minimize", "IC_7", "RESOLVED"]]);
  assert.deepEqual(held.assignees.map((assignee) => assignee.login), ["alice"]);
});

test("a minimized command was handled already and is not handled again; denounced authors and bots are left alone", async () => {
  const issue = claimIssue(120);
  const github = fakeGithub({
    permissions: { mallory: "read" },
    issues: [issue],
    comments: { 120: [comment(1, "stranger", "/take", CLAIMED, { minimized: "RESOLVED" }), comment(2, "mallory", "/take"), comment(3, "renovate[bot]", "/take")] },
  });
  await command(github, issue);
  assert.deepEqual(github.writes(), []);
});

test("two unhandled /take in one run: the earlier one gets the issue, the later one the reply, which then stays", async () => {
  const issue = claimIssue(120);
  const github = fakeGithub({
    issues: [issue],
    comments: { 120: [comment(2, "alice", "/take", "2026-11-17T10:00:00Z"), comment(1, "stranger", "/take", "2026-11-17T09:00:00Z")] },
  });
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [
    ["assign", 120, "stranger"],
    ["react", 1, "+1"],
    ["minimize", "IC_1", "RESOLVED"],
    ["react", 2, "-1"],
    ["reply", 120, "@stranger is already working on this."],
    ["minimize", "IC_2", "RESOLVED"],
  ]);
});

test("the already-working reply is never posted twice", async () => {
  const issue = claimIssue(120, { assignees: ["alice"] });
  const github = fakeGithub({
    issues: [issue],
    comments: { 120: [comment(5, "github-actions[bot]", "@alice is already working on this.", "2026-11-17T08:00:00Z"), comment(1, "stranger", "/take")] },
  });
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [["react", 1, "-1"], ["minimize", "IC_1", "RESOLVED"]]);
  const twice = claimIssue(120, { assignees: ["alice"] });
  const both = fakeGithub({
    issues: [twice],
    comments: { 120: [comment(1, "stranger", "/take", "2026-11-17T09:00:00Z"), comment(2, "bob", "/take", "2026-11-17T10:00:00Z")] },
  });
  await command(both, twice);
  assert.deepEqual(claimWrites(both).filter((write) => write[0] === "reply"), [["reply", 120, "@alice is already working on this."]]);
});

test("a reply retired when its holder left is posted afresh when they hold the issue again", async () => {
  const issue = claimIssue(120, { assignees: ["alice"] });
  const retired = comment(5, "github-actions[bot]", "@alice is already working on this.", "2026-11-17T08:00:00Z", { minimized: "OUTDATED" });
  const github = fakeGithub({ issues: [issue], comments: { 120: [retired, comment(1, "stranger", "/take")] } });
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [
    ["react", 1, "-1"],
    ["reply", 120, "@alice is already working on this."],
    ["minimize", "IC_1", "RESOLVED"],
  ]);
});

test("an outsider whose other /take landed meanwhile is unassigned again and told about the cap, whichever issue number is lower", async () => {
  for (const other of [119, 131]) {
    const held = [121, 122].map((number) => claimIssue(number, { assignees: ["stranger"] }));
    const elsewhere = claimIssue(other);
    const issue = claimIssue(120);
    const github = fakeGithub({ issues: [issue, elsewhere, ...held], comments: { 120: [comment(1, "stranger", "/take")] } });
    const assign = github.rest.issues.addAssignees;
    github.rest.issues.addAssignees = async (params) => {
      elsewhere.assignees.push({ login: "stranger", type: "User" });
      return assign(params);
    };
    await command(github, issue);
    assert.deepEqual(claimWrites(github), [
      ["assign", 120, "stranger"],
      ["unassign", 120, "stranger"],
      ["react", 1, "-1"],
      ["reply", 120, "@stranger, you hold 3 issues already."],
      ["minimize", "IC_1", "RESOLVED"],
    ], String(other));
    assert.deepEqual(issue.assignees, [], String(other));
  }
});

test("the cap counts what the outsider holds after the take, so an assignment a maintainer moved meanwhile costs nothing", async () => {
  const held = [121, 122].map((number) => claimIssue(number, { assignees: ["stranger"] }));
  const moved = claimIssue(119);
  const issue = claimIssue(120);
  const github = fakeGithub({ issues: [issue, moved, ...held], comments: { 120: [comment(1, "stranger", "/take")] } });
  const assign = github.rest.issues.addAssignees;
  github.rest.issues.addAssignees = async (params) => {
    held[0].assignees = [];
    moved.assignees.push({ login: "stranger", type: "User" });
    return assign(params);
  };
  await command(github, issue);
  assert.deepEqual(claimWrites(github), [["assign", 120, "stranger"], ["react", 1, "+1"], ["minimize", "IC_1", "RESOLVED"]]);
});

test("any admitted event on the issue handles a command whose own run was dropped", async () => {
  const waiting = () => ({ 120: [comment(1, "stranger", "/take")] });
  const taken = [["assign", 120, "stranger"], ["react", 1, "+1"], ["minimize", "IC_1", "RESOLVED"]];
  const chatted = claimIssue(120);
  const chat = fakeGithub({ issues: [chatted], comments: waiting() });
  await command(chat, chatted, "/take please");
  assert.deepEqual(claimWrites(chat), taken);
  const labelled = claimIssue(120);
  const label = fakeGithub({ issues: [labelled], comments: waiting() });
  await invoke("run", { github: label, eventName: "issues", payload: { action: "labeled", label: { name: "bug" }, issue: labelled } });
  assert.deepEqual(claimWrites(label), taken);
  const freed = claimIssue(120);
  const unassigned = fakeGithub({ issues: [freed], comments: waiting() });
  await invoke("run", { github: unassigned, eventName: "issues", payload: { action: "unassigned", issue: freed } });
  assert.deepEqual(claimWrites(unassigned), taken);
  const back = claimIssue(120);
  const reopened = fakeGithub({ issues: [back], comments: waiting() });
  await invoke("run", { github: reopened, eventName: "issues", payload: { action: "reopened", issue: back } });
  assert.deepEqual(claimWrites(reopened), taken);
});

test("a command handled by a run that died before tidying up is tidied by the next event", async () => {
  const issue = claimIssue(120);
  const waiting = fresh(142, "bob", { created_at: CLAIMED, linked: [120], labels: [ALREADY_CLAIMED, INCOMPLETE] });
  const github = fakeGithub({
    issues: [issue],
    pulls: [waiting],
    comments: {
      120: [
        comment(5, "github-actions[bot]", "@stranger is already working on this.", "2026-11-17T08:00:00Z"),
        comment(6, "stranger", "/drop", CLAIMED, { minimized: "RESOLVED" }),
      ],
    },
  });
  await command(github, issue, "/drop");
  assert.deepEqual(claimWrites(github), [["minimize", "IC_5", "OUTDATED"]]);
  assert.deepEqual(ruleWrites(github), [["add", 142, READY], ["remove", 142, ALREADY_CLAIMED], ["remove", 142, INCOMPLETE]]);
});

test("the reply naming a pull request's author is retired when that pull request closes", async () => {
  const closed = fresh(130, "alice", { created_at: CLAIMED, linked: [120], state: "closed" });
  const github = fakeGithub({
    issues: [claimIssue(120)],
    pulls: [closed],
    comments: { 120: [comment(5, "github-actions[bot]", "@alice is already working on this in #130.", "2026-11-17T10:00:00Z")] },
  });
  await event(github, "closed", closed);
  assert.deepEqual(claimWrites(github), [["minimize", "IC_5", "OUTDATED"]]);
  const open = fresh(130, "alice", { created_at: CLAIMED, linked: [120] });
  const another = fresh(131, "bob", { created_at: "2026-11-17T10:00:00Z", linked: [120], state: "closed" });
  const still = fakeGithub({
    issues: [claimIssue(120)],
    pulls: [open, another],
    comments: { 120: [comment(5, "github-actions[bot]", "@alice is already working on this in #130.", "2026-11-17T10:00:00Z")] },
  });
  await event(still, "closed", another);
  assert.deepEqual(claimWrites(still), []);
  const first = fresh(130, "alice", { created_at: CLAIMED, linked: [120], state: "closed" });
  const second = fresh(133, "alice", { created_at: "2026-11-17T11:00:00Z", linked: [120] });
  const moved = fakeGithub({
    issues: [claimIssue(120)],
    pulls: [first, second],
    comments: { 120: [comment(5, "github-actions[bot]", "@alice is already working on this in #130.", "2026-11-17T10:00:00Z")] },
  });
  await event(moved, "closed", first);
  assert.deepEqual(claimWrites(moved), [["minimize", "IC_5", "OUTDATED"]]);
});

test("a /take GitHub will not assign gets a confused reaction and a warning, and nothing else", async () => {
  const issue = claimIssue(120);
  const github = fakeGithub({ issues: [issue], unassignable: ["stranger"], comments: { 120: [comment(1, "stranger", "/take")] } });
  const { core } = await command(github, issue);
  assert.deepEqual(claimWrites(github), [["assign", 120, "stranger"], ["react", 1, "confused"], ["minimize", "IC_1", "RESOLVED"]]);
  assert.equal(core.warnings.length, 1);
});

test("rule decision: already-claimed blocks ready for a ruled pull request created since the claims rule", () => {
  const taken = [{ number: 120, state: "open", labels: ["bug"], assignees: ["alice"], pulls: [] }];
  for (const tier of ["outsider", "trusted"]) {
    assert.deepEqual(vouch.ruleLabels(facts({ tier, login: "stranger", createdAt: CLAIMED, linkedIssues: taken })), [ALREADY_CLAIMED, INCOMPLETE], tier);
  }
  assert.deepEqual(vouch.ruleLabels(facts({ login: "Alice", createdAt: CLAIMED, linkedIssues: taken })), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ login: "stranger", createdAt: "2026-11-16T11:59:59Z", linkedIssues: taken })), [READY]);
  assert.deepEqual(vouch.ruleLabels(facts({ login: "stranger", createdAt: vouch.CLAIMS_START, linkedIssues: taken })), [ALREADY_CLAIMED, INCOMPLETE]);
  assert.deepEqual(vouch.ruleLabels(facts({ login: "stranger", createdAt: CLAIMED, linkedIssues: [{ ...taken[0], state: "closed" }] })), [READY]);
});

test("a pull request for an issue someone else holds gets already-claimed, by assignee or by an earlier pull request", async () => {
  const assigned = claimIssue(120, { assignees: ["alice"] });
  const pull = fresh(140, "stranger", { created_at: CLAIMED, linked: [120] });
  const github = fakeGithub({ pulls: [pull], issues: [assigned] });
  await event(github, "opened", pull);
  assert.deepEqual(ruleWrites(github), [["add", 140, ALREADY_CLAIMED, INCOMPLETE], ["status", "sha140", "success"]]);
  const earlier = fresh(139, "alice", { created_at: "2026-11-17T08:00:00Z", linked: [120], labels: [READY] });
  const byPull = fakeGithub({ pulls: [earlier, pull], issues: [claimIssue(120)] });
  await event(byPull, "opened", pull);
  assert.deepEqual(ruleWrites(byPull), [["add", 140, ALREADY_CLAIMED, INCOMPLETE], ["status", "sha140", "success"]]);
});

test("already-claimed comes off when the holder's pull request closes, and goes on when it reopens", async () => {
  const holder = fresh(141, "alice", { created_at: CLAIMED, linked: [120], state: "closed" });
  const waiting = fresh(142, "stranger", { created_at: "2026-11-17T10:00:00Z", linked: [120], labels: [ALREADY_CLAIMED, INCOMPLETE] });
  const github = fakeGithub({ pulls: [holder, waiting], issues: [claimIssue(120)] });
  await event(github, "closed", holder);
  assert.deepEqual(ruleWrites(github), [["add", 142, READY], ["remove", 142, ALREADY_CLAIMED], ["remove", 142, INCOMPLETE], ["status", "sha142", "success"]]);
  const reopened = fresh(141, "alice", { created_at: CLAIMED, linked: [120] });
  const ready = fresh(142, "stranger", { created_at: "2026-11-17T10:00:00Z", linked: [120], labels: [READY] });
  const again = fakeGithub({ pulls: [reopened, ready], issues: [claimIssue(120)] });
  await event(again, "reopened", reopened);
  assert.deepEqual(ruleWrites(again), [["add", 141, READY], ["add", 142, ALREADY_CLAIMED, INCOMPLETE], ["remove", 142, READY], ["status", "sha142", "success"]]);
});

test("a maintainer picks the winner by assigning the issue: the assignee beats the earliest pull request", async () => {
  const issue = claimIssue(120, { assignees: ["bob"] });
  const earliest = fresh(142, "stranger", { created_at: CLAIMED, linked: [120], labels: [READY] });
  const chosen = fresh(143, "bob", { created_at: "2026-11-17T10:00:00Z", linked: [120], labels: [ALREADY_CLAIMED, INCOMPLETE] });
  const github = fakeGithub({ pulls: [earliest, chosen], issues: [issue] });
  await invoke("run", { github, eventName: "issues", payload: { action: "assigned", issue } });
  assert.deepEqual(ruleWrites(github), [
    ["add", 142, ALREADY_CLAIMED, INCOMPLETE],
    ["remove", 142, READY],
    ["status", "sha142", "success"],
    ["add", 143, READY],
    ["remove", 143, ALREADY_CLAIMED],
    ["remove", 143, INCOMPLETE],
  ]);
  const onPull = fakeGithub({ pulls: [earliest] });
  await invoke("run", { github: onPull, eventName: "issues", payload: { action: "assigned", issue: { ...issue, pull_request: {} } } });
  assert.deepEqual(onPull.calls, []);
});

test("already-claimed is never given to a pull request from before the claims rule, nor to the team", async () => {
  const assigned = claimIssue(120, { assignees: ["alice"] });
  for (const created of [NEW, "2026-11-16T11:59:59Z"]) {
    const pull = fresh(144, "stranger", { created_at: created, linked: [120] });
    const github = fakeGithub({ pulls: [pull], issues: [assigned] });
    await event(github, "edited", pull);
    assert.deepEqual(ruleWrites(github), [["add", 144, READY], ["status", "sha144", "success"]], created);
  }
  const team = fresh(145, "shivamhwp", { created_at: CLAIMED, linked: [120] });
  const github = fakeGithub({ pulls: [team], issues: [assigned] });
  await event(github, "opened", team);
  assert.deepEqual(ruleWrites(github), []);
});

test("a stacked pull request reads the claim from the issue its description closes; a missing number is skipped", async () => {
  const assigned = claimIssue(120, { assignees: ["alice"] });
  for (const login of ["stranger", "bob"]) {
    const pull = fresh(146, login, { created_at: CLAIMED, base: "release", linked: [], body: `Fixes #120\n${SHOT}` });
    const github = fakeGithub({ pulls: [pull], issues: [assigned] });
    await event(github, "edited", pull);
    assert.deepEqual(ruleWrites(github)[0], ["add", 146, ALREADY_CLAIMED, INCOMPLETE], login);
  }
  const missing = fresh(147, "bob", { created_at: CLAIMED, base: "release", linked: [], body: `Fixes #999\n${SHOT}` });
  const github = fakeGithub({ pulls: [missing] });
  const graphql = github.graphql;
  github.graphql = async (query, variables) => {
    if (/query VouchIssueClaim/.test(query) && variables.number === 999) {
      throw Object.assign(new Error("Could not resolve"), { errors: [{ type: "NOT_FOUND" }] });
    }
    return graphql(query, variables);
  };
  await event(github, "edited", missing);
  assert.deepEqual(ruleWrites(github), [["add", 147, READY]]);
});

function claimSweepFixture() {
  const assignedOn = (login) => [{ login, at: "2026-11-17T00:00:00Z" }];
  return fakeGithub({
    issues: [
      claimIssue(150, { assignees: ["quiet"], assigned: assignedOn("quiet") }),
      claimIssue(151, { assignees: ["busy"], assigned: assignedOn("busy") }),
      claimIssue(152, { assignees: ["coder"], assigned: assignedOn("coder") }),
      claimIssue(153, { assignees: ["renovate[bot]"] }),
    ],
    pulls: [pr(160, "coder", { created_at: OLD, linked: [152] })],
    comments: {
      150: [comment(7, "github-actions[bot]", "@quiet is already working on this.", "2026-11-17T02:00:00Z")],
      151: [comment(8, "busy", "still on it", "2026-11-22T00:00:00Z")],
    },
  });
}

const SWEEP_NOW = () => Date.parse("2026-11-25T00:00:00Z");

test("the sweep releases a claim quiet for five days, keeps a fresh one and one with an open pull request", async () => {
  const github = claimSweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "schedule", now: SWEEP_NOW });
  assert.deepEqual(claimWrites(github), [["unassign", 150, "quiet"], ["minimize", "IC_7", "OUTDATED"]]);
  assert.deepEqual(result.claims, { held: 3, released: [{ number: 150, logins: ["quiet"] }] });
  assert.match(core.summaries[0], /3 open issues are held by an assignee\./);
  assert.match(core.summaries[0], /Released after 5 quiet days \(1\)\n- issue #150 from @quiet/);
});

test("a dry-run sweep releases nothing but reports the claims it would release", async () => {
  const github = claimSweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "workflow_dispatch", payload: { inputs: { dry_run: "true" } }, now: SWEEP_NOW });
  assert.deepEqual(github.writes(), []);
  assert.deepEqual(result.claims.released, [{ number: 150, logins: ["quiet"] }]);
  assert.match(core.summaries[0], /Would release after 5 quiet days \(1\)/);
});
