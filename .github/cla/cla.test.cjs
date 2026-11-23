const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cla = require("./cla.cjs");

const REPO_ID = 1274703665;
const SIGN = "I have read the CLA Document and I hereby sign the CLA";
const NOT_SIGNED_TAIL = "<sub>You can retrigger this bot by commenting **recheck** in this Pull Request. </sub><sub>Posted by the **CLA Assistant Lite bot**.</sub>";
const SIGNED_COMMENT = `${cla.CONFIG.allSignedComment}<br/><sub>Posted by the ****CLA Assistant Lite bot****.</sub>`;
const NOT_SIGNED_ONE = `${cla.CONFIG.notSignedComment}\n   - - -\n   ${SIGN}\n   - - -\n   ${NOT_SIGNED_TAIL}`;

const users = {
  owner: { login: "mantrakp04", databaseId: 1001 },
  alice: { login: "alice", databaseId: 2002 },
  bob: { login: "bob", databaseId: 3003 },
  dependabot: { login: "dependabot[bot]", databaseId: 4004 },
};

function commitBy(user, { name, email = "x@example.com" } = {}) {
  return {
    commit: {
      author: { email, name: name || (user ? user.login : "Someone"), user: user || null },
      committer: { name: "GitHub", user: user || null },
    },
  };
}

function commentBy(login, body, id, { bot = false, databaseId } = {}) {
  const author = bot
    ? { __typename: "Bot", login: login.replace(/\[bot\]$/, ""), databaseId: databaseId || 41898282 }
    : { __typename: "User", login, databaseId: databaseId || Object.values(users).find((user) => user.login === login).databaseId };
  return { fullDatabaseId: String(id), createdAt: "2026-11-23T10:00:00Z", body, author };
}

function connection(nodes, size = 100) {
  return { all: nodes, size };
}

function fakeGithub({ commits = [], comments = [], signed = [], fileMissing = false, truncated = false, runs = [], conflictOnce = false } = {}) {
  const calls = [];
  const file = { signedContributors: signed };
  let sha = "blob1";
  let conflicted = false;
  const page = (list, after, size) => {
    const start = after ? Number(after) : 0;
    const nodes = list.slice(start, start + size);
    return { nodes, pageInfo: { hasNextPage: start + size < list.length, endCursor: String(start + size) } };
  };
  const record = (name, handler) => async (params) => {
    calls.push({ name, params });
    return handler(params || {});
  };
  const blob = () => (fileMissing ? null : { oid: sha, text: truncated ? "" : JSON.stringify(file), isTruncated: truncated });
  const graphql = async (query, variables) => {
    const operation = /query (\w+)/.exec(query)[1];
    calls.push({ name: `graphql.${operation}`, params: variables });
    if (operation === "ClaSignatures") return { repository: { signatures: blob() } };
    if (operation === "ClaCommits") return { repository: { pullRequest: { commits: page(commits, variables.after, 100) } } };
    if (operation === "ClaComments") return { repository: { pullRequest: { comments: page(comments, variables.after, 100) } } };
    assert.equal(variables.signatures, "cla-signatures:signatures/cla-v1.json");
    return {
      repository: {
        signatures: blob(),
        pullRequest: { headRefOid: "head1", headRefName: "feature", headRepository: { nameWithOwner: "alice/ardia" }, commits: page(commits, null, 100), comments: page(comments, null, 100) },
      },
    };
  };
  const rest = {
    repos: {
      getContent: record("repos.getContent", () => ({ data: { content: Buffer.from(JSON.stringify(file)).toString("base64"), encoding: "base64" } })),
      createOrUpdateFileContents: record("repos.createOrUpdateFileContents", (params) => {
        if (conflictOnce && !conflicted) {
          conflicted = true;
          file.signedContributors.push({ name: "racer", id: 9999 });
          sha = "blob2";
          throw Object.assign(new Error("conflict"), { status: 409 });
        }
        return { data: {} };
      }),
    },
    issues: {
      createComment: record("issues.createComment", () => ({ data: {} })),
      updateComment: record("issues.updateComment", () => ({ data: {} })),
      lock: record("issues.lock", () => ({ data: {} })),
    },
    actions: {
      listWorkflowRuns: record("actions.listWorkflowRuns", () => ({ data: { workflow_runs: runs } })),
      reRunWorkflow: record("actions.reRunWorkflow", () => ({ data: {} })),
    },
  };
  return { graphql, rest, calls, names: () => calls.map((call) => call.name), named: (name) => calls.filter((call) => call.name === name) };
}

function fakeCore() {
  const core = { failed: null, errors: [] };
  core.info = () => {};
  core.error = (message) => core.errors.push(message);
  core.setFailed = (message) => (core.failed = message);
  return core;
}

function pullEvent(action, extra = {}) {
  return {
    eventName: "pull_request_target",
    actor: "alice",
    repo: { owner: "ardia-browser", repo: "ardia" },
    payload: { action, repository: { id: REPO_ID }, pull_request: { number: 77, merged: false, ...extra } },
  };
}

function commentEvent(body, login = "alice") {
  return {
    eventName: "issue_comment",
    actor: login,
    repo: { owner: "ardia-browser", repo: "ardia" },
    payload: { action: "created", repository: { id: REPO_ID }, issue: { number: 77, pull_request: {} }, comment: { body, user: { login } } },
  };
}

async function runWith(github, context) {
  const core = fakeCore();
  const outcome = await cla.run({ github, context, core });
  return { core, outcome };
}

test("the owner's push costs one GraphQL read and nothing else", async () => {
  const github = fakeGithub({ commits: [commitBy(users.owner), commitBy(users.owner), commitBy(users.dependabot)] });
  const { core } = await runWith(github, pullEvent("synchronize"));
  assert.equal(core.failed, null);
  assert.deepEqual(github.names(), ["graphql.ClaPull"]);
});

test("a contributor who signed before passes with one read, and the action's re-run lookups are gone", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)], signed: [{ name: "alice", id: 2002 }] });
  for (const action of ["opened", "synchronize", "reopened"]) {
    const { core } = await runWith(github, pullEvent(action));
    assert.equal(core.failed, null, action);
  }
  assert.deepEqual(github.names(), ["graphql.ClaPull", "graphql.ClaPull", "graphql.ClaPull"]);
});

test("an unsigned contributor gets the action's comment once and the check fails", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)] });
  const { core } = await runWith(github, pullEvent("opened"));
  assert.equal(core.failed, "Committers of Pull Request number 77 have to sign the CLA 📝");
  assert.deepEqual(github.names(), ["graphql.ClaPull", "issues.createComment"]);
  assert.equal(github.named("issues.createComment")[0].params.body, NOT_SIGNED_ONE);
  assert.equal(github.named("issues.createComment")[0].params.issue_number, 77);
});

test("a push to an unsigned pull request whose comment already says so writes nothing", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)], comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true })] });
  const { core } = await runWith(github, pullEvent("synchronize"));
  assert.ok(core.failed);
  assert.deepEqual(github.names(), ["graphql.ClaPull"]);
});

test("signing by comment records the signature, flips the comment and re-runs the failed check", async () => {
  const github = fakeGithub({
    commits: [commitBy(users.alice), commitBy(users.owner)],
    comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true }), commentBy("alice", SIGN, 6400000001)],
    signed: [{ name: "torztomasz", id: 93620601, comment_id: 1, created_at: "2026-10-24T11:19:19Z", repoId: REPO_ID, pullRequestNo: 72 }],
    runs: [{ id: 555, conclusion: "failure", head_branch: "feature", head_repository: { full_name: "alice/ardia" } }],
  });
  const { core } = await runWith(github, commentEvent(SIGN));
  assert.equal(core.failed, null);
  assert.deepEqual(github.names(), [
    "graphql.ClaPull",
    "issues.updateComment",
    "repos.createOrUpdateFileContents",
    "actions.listWorkflowRuns",
    "actions.reRunWorkflow",
  ]);
  assert.deepEqual(github.named("issues.updateComment")[0].params, { owner: "ardia-browser", repo: "ardia", comment_id: 501, body: SIGNED_COMMENT });
  const put = github.named("repos.createOrUpdateFileContents")[0].params;
  assert.equal(put.branch, "cla-signatures");
  assert.equal(put.path, "signatures/cla-v1.json");
  assert.equal(put.sha, "blob1");
  assert.equal(put.message, "alice signed the CLA in ardia-browser/ardia#77");
  const written = Buffer.from(put.content, "base64").toString("utf8");
  assert.equal(written, JSON.stringify(JSON.parse(written), null, 2));
  assert.deepEqual(JSON.parse(written).signedContributors.at(-1), {
    name: "alice",
    id: 2002,
    comment_id: 6400000001,
    created_at: "2026-11-23T10:00:00Z",
    repoId: REPO_ID,
    pullRequestNo: 77,
  });
  assert.equal(JSON.parse(written).signedContributors.length, 2);
  assert.deepEqual(github.named("actions.listWorkflowRuns")[0].params, {
    owner: "ardia-browser",
    repo: "ardia",
    workflow_id: "cla.yml",
    event: "pull_request_target",
    head_sha: "head1",
    branch: "feature",
    per_page: 20,
  });
  assert.equal(github.named("actions.reRunWorkflow")[0].params.run_id, 555);
});

test("a recheck on a signed pull request whose last run passed re-runs nothing", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)], signed: [{ name: "alice", id: 2002 }], runs: [{ id: 556, conclusion: "success", head_branch: "feature", head_repository: { full_name: "alice/ardia" } }] });
  const { core } = await runWith(github, commentEvent("recheck"));
  assert.equal(core.failed, null);
  assert.deepEqual(github.names(), ["graphql.ClaPull", "actions.listWorkflowRuns"]);
});

test("a signature by someone who isn't a committer, or before the bot asked, signs nobody", async () => {
  const stranger = fakeGithub({
    commits: [commitBy(users.alice)],
    comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true }), commentBy("bob", SIGN, 601)],
  });
  assert.ok((await runWith(stranger, commentEvent(SIGN, "bob"))).core.failed);
  assert.deepEqual(stranger.names(), ["graphql.ClaPull"]);
  const early = fakeGithub({ commits: [commitBy(users.alice)], comments: [commentBy("alice", SIGN, 602)] });
  assert.ok((await runWith(early, pullEvent("opened"))).core.failed);
  assert.deepEqual(early.names(), ["graphql.ClaPull", "issues.createComment"]);
});

test("a look-alike bot comment from a person is not the bot's comment", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)], comments: [commentBy("bob", "Posted by the **CLA Assistant Lite bot**.", 700), commentBy("alice", SIGN, 701)] });
  const { core } = await runWith(github, pullEvent("synchronize"));
  assert.ok(core.failed);
  assert.deepEqual(github.names(), ["graphql.ClaPull", "issues.createComment"]);
  assert.deepEqual(github.named("repos.createOrUpdateFileContents"), []);
});

test("a commit from no GitHub user can't be signed for, and the comment says so", async () => {
  const github = fakeGithub({ commits: [commitBy(null, { name: "Ghost Writer" })] });
  const { core } = await runWith(github, pullEvent("opened"));
  assert.ok(core.failed);
  const body = github.named("issues.createComment")[0].params.body;
  assert.match(body, /\*\*Ghost Writer\*\* seems not to be a GitHub user\. You need a GitHub account to be able to sign the CLA\./);
});

test("an unlinked commit that only claims an allowlisted name still has to sign", async () => {
  const github = fakeGithub({ commits: [commitBy(null, { name: "mantrakp04" })] });
  const { core } = await runWith(github, pullEvent("opened"));
  assert.ok(core.failed);
  assert.match(github.named("issues.createComment")[0].params.body, /\*\*mantrakp04\*\* seems not to be a GitHub user/);
  const behindTheOwner = fakeGithub({ commits: [commitBy(users.owner), commitBy(null, { name: "mantrakp04" })] });
  assert.ok((await runWith(behindTheOwner, pullEvent("opened"))).core.failed);
  const linked = fakeGithub({ commits: [commitBy(users.owner)] });
  assert.equal((await runWith(linked, pullEvent("opened"))).core.failed, null);
});

test("signing re-runs this pull request's failed run, not a run of another branch on the same commit", async () => {
  const github = fakeGithub({
    commits: [commitBy(users.alice)],
    comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true }), commentBy("alice", SIGN, 6400000002)],
    runs: [
      { id: 560, conclusion: "success", head_branch: "other", head_repository: { full_name: "alice/ardia" } },
      { id: 561, conclusion: "failure", head_branch: "feature", head_repository: { full_name: "alice/ardia" } },
    ],
  });
  await runWith(github, commentEvent(SIGN));
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [561]);
});

test("two committers get the table the action wrote", () => {
  const map = { signed: [{ name: "alice", id: 2002 }], notSigned: [{ name: "bob", id: 3003 }], unknown: [] };
  assert.equal(
    cla.commentContent(false, map),
    `${cla.CONFIG.notSignedComment}\n   - - -\n   ${SIGN}\n   - - -\n   **1** out of **2** committers have signed the CLA.<br/>:white_check_mark: (alice)[https://github.com/alice]<br/>:x: @bob<br/>${NOT_SIGNED_TAIL}`,
  );
});

test("the allowlist matches exact names, and patterns with a star", () => {
  assert.ok(cla.allowlisted("mantrakp04"));
  assert.ok(cla.allowlisted("dependabot[bot]"));
  assert.ok(!cla.allowlisted("Mantrakp04"));
  assert.ok(!cla.allowlisted("renovate[bot]"));
  assert.ok(cla.allowlisted("renovate[bot]", ["*[bot]"]));
});

test("committers are read past the first 100 commits, and comments past the first 100", async () => {
  const commits = [...Array.from({ length: 150 }, () => commitBy(users.owner)), commitBy(users.bob)];
  const comments = [...Array.from({ length: 120 }, (_, at) => commentBy("alice", "looks good", 800 + at))];
  const github = fakeGithub({ commits, comments });
  const { core } = await runWith(github, pullEvent("synchronize"));
  assert.ok(core.failed);
  assert.deepEqual(github.names(), ["graphql.ClaPull", "graphql.ClaCommits", "graphql.ClaComments", "issues.createComment"]);
  assert.match(github.named("issues.createComment")[0].params.body, /we ask that|sign it by posting/);
});

test("a signature that loses a race to another is written again on top of it", async () => {
  const github = fakeGithub({
    commits: [commitBy(users.alice)],
    comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true }), commentBy("alice", SIGN, 901)],
    conflictOnce: true,
  });
  const { core } = await runWith(github, commentEvent(SIGN));
  assert.equal(core.failed, null);
  const puts = github.named("repos.createOrUpdateFileContents");
  assert.equal(puts.length, 2);
  assert.equal(puts[1].params.sha, "blob2");
  const names = JSON.parse(Buffer.from(puts[1].params.content, "base64").toString("utf8")).signedContributors.map((entry) => entry.name);
  assert.deepEqual(names, ["racer", "alice"]);
});

test("a signature file too big for GraphQL is read once over REST", async () => {
  const github = fakeGithub({ commits: [commitBy(users.alice)], signed: [{ name: "alice", id: 2002 }], truncated: true });
  const { core } = await runWith(github, pullEvent("synchronize"));
  assert.equal(core.failed, null);
  assert.deepEqual(github.names(), ["graphql.ClaPull", "repos.getContent"]);
});

test("a missing signature file is created with the first signature", async () => {
  const github = fakeGithub({
    commits: [commitBy(users.alice)],
    comments: [commentBy("github-actions[bot]", NOT_SIGNED_ONE, 501, { bot: true }), commentBy("alice", SIGN, 902)],
    fileMissing: true,
  });
  await runWith(github, commentEvent(SIGN));
  const put = github.named("repos.createOrUpdateFileContents")[0].params;
  assert.equal(put.sha, undefined);
  assert.equal(put.message, "Create the CLA signature file");
});

test("a merged pull request is locked; a closed one is left alone; neither reads anything", async () => {
  const merged = fakeGithub();
  await runWith(merged, pullEvent("closed", { merged: true }));
  assert.deepEqual(merged.names(), ["issues.lock"]);
  const closed = fakeGithub();
  await runWith(closed, pullEvent("closed"));
  assert.deepEqual(closed.names(), []);
});

test("the workflow runs the default branch's script with no pull request code and no credentials on disk", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "workflows", "cla.yml"), "utf8");
  assert.ok(!/contributor-assistant/.test(text));
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /sparse-checkout: \.github\n/);
  assert.ok(!/head\.(sha|ref)|pull_request\.head/.test(text), "never checks out the pull request");
  assert.match(text, /require\(`\$\{process\.env\.GITHUB_WORKSPACE\}\/\.github\/cla\/cla\.cjs`\)/);
});
