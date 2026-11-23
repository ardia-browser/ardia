const CONFIG = {
  signaturesPath: "signatures/cla-v1.json",
  branch: "cla-signatures",
  documentUrl: "https://github.com/mantrakp04/ardia/blob/main/CLA.md",
  allowlist: ["mantrakp04", "dependabot[bot]", "github-actions[bot]", "posthog-eu[bot]"],
  createFileMessage: "Create the CLA signature file",
  signedMessage: "$contributorName signed the CLA in $owner/$repo#$pullRequestNo",
  notSignedComment:
    "Thanks for the pull request! Before it can be merged, please read the [Contributor License Agreement](https://github.com/mantrakp04/ardia/blob/main/CLA.md) and sign it by posting the comment below. You only sign once, and it covers all your contributions.",
  allSignedComment: "Everyone on this pull request has signed the CLA. Thanks!",
  signPhrase: "I have read the CLA Document and I hereby sign the CLA",
  workflowFile: "cla.yml",
};

const GITHUB_ACTIONS_USER_ID = 41898282;
const WORKFLOW_BOT = "github-actions[bot]";
const BOT_MARKER = /.*CLA Assistant Lite bot.*/m;
const SIGNATURE = /^.*i \s*have \s*read \s*the \s*cla \s*document \s*and \s*i \s*hereby \s*sign \s*the \s*cla.*$/;
const PAGE = 100;

const COMMIT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    commit {
      author { email name user { databaseId login } }
      committer { name user { databaseId login } }
    }
  }`;

const COMMENT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    fullDatabaseId
    createdAt
    body
    author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
  }`;

const CLA_QUERY = `
query ClaPull($owner: String!, $repo: String!, $number: Int!, $signatures: String!) {
  repository(owner: $owner, name: $repo) {
    signatures: object(expression: $signatures) { ... on Blob { oid text isTruncated } }
    pullRequest(number: $number) {
      headRefOid
      headRefName
      headRepository { nameWithOwner }
      commits(first: ${PAGE}) { ${COMMIT_FIELDS} }
      comments(first: ${PAGE}) { ${COMMENT_FIELDS} }
    }
  }
}`;

const MORE_COMMITS_QUERY = `
query ClaCommits($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { commits(first: ${PAGE}, after: $after) { ${COMMIT_FIELDS} } }
  }
}`;

const MORE_COMMENTS_QUERY = `
query ClaComments($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { comments(first: ${PAGE}, after: $after) { ${COMMENT_FIELDS} } }
  }
}`;

const SIGNATURES_QUERY = `
query ClaSignatures($owner: String!, $repo: String!, $signatures: String!) {
  repository(owner: $owner, name: $repo) {
    signatures: object(expression: $signatures) { ... on Blob { oid text isTruncated } }
  }
}`;

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function allowlisted(name, allowlist = CONFIG.allowlist) {
  return allowlist.some((raw) => {
    const pattern = raw.trim();
    if (pattern.includes("*")) return new RegExp(escapeRegExp(pattern).split("\\*").join(".*")).test(name);
    return pattern === name;
  });
}

function committerOf(commit) {
  return commit.author.user || commit.committer.user || commit.author || commit.committer;
}

function committersOf(commits, number, allowlist = CONFIG.allowlist) {
  const committers = [];
  for (const commit of commits) {
    const who = committerOf(commit);
    const user = { name: who.login || who.name, id: who.databaseId || "", pullRequestNo: number };
    const same = (known) => known.name === user.name && (known.id === user.id || !allowlisted(user.name, allowlist));
    if (!committers.some(same)) committers.push(user);
  }
  const exempt = (committer) => allowlisted(committer.name, allowlist) && (Boolean(committer.id) || committer.name.endsWith("[bot]"));
  return committers.filter((committer) => committer.id !== GITHUB_ACTIONS_USER_ID && !exempt(committer));
}

function committerMap(committers, signedContributors) {
  const isSigned = (committer) => signedContributors.some((signature) => committer.id === signature.id);
  return {
    signed: committers.filter(isSigned),
    notSigned: committers.filter((committer) => !isSigned(committer)),
    unknown: committers.filter((committer) => !committer.id),
  };
}

function commentLogin(author) {
  if (!author || !author.login) return null;
  return author.__typename === "Bot" && !author.login.endsWith("[bot]") ? `${author.login}[bot]` : author.login;
}

function signsTheCla(comment) {
  return comment.login !== WORKFLOW_BOT && SIGNATURE.test(comment.body.trim().toLowerCase());
}

function commentContent(signed, map, config = CONFIG) {
  if (signed) return `${config.allSignedComment}<br/><sub>Posted by the ****CLA Assistant Lite bot****.</sub>`;
  const count = map.signed.length + map.notSigned.length;
  const you = count > 1 ? "you all" : "you";
  let text = `${config.notSignedComment.replace("$you", you)}
   - - -
   ${config.signPhrase}
   - - -
   `;
  if (count > 1) {
    text += `**${map.signed.length}** out of **${count}** committers have signed the CLA.`;
    for (const committer of map.signed) text += `<br/>:white_check_mark: (${committer.name})[https://github.com/${committer.name}]`;
    for (const committer of map.notSigned) text += `<br/>:x: @${committer.name}`;
    text += "<br/>";
  }
  if (map.unknown.length > 0) {
    const seem = map.unknown.length > 1 ? "seem" : "seems";
    text += `**${map.unknown.map((committer) => committer.name).join(", ")}** ${seem} not to be a GitHub user.`;
    text +=
      " You need a GitHub account to be able to sign the CLA. If you have already a GitHub account, please [add the email address used for this commit to your account](https://help.github.com/articles/why-are-my-commits-linked-to-the-wrong-user/#commits-are-not-linked-to-any-user).<br/>";
  }
  text += "<sub>You can retrigger this bot by commenting **recheck** in this Pull Request. </sub>";
  text += "<sub>Posted by the **CLA Assistant Lite bot**.</sub>";
  return text;
}

function evaluate({ committers, signedContributors, comments, hasBotComment, repoId, number }) {
  const map = committerMap(committers, signedContributors);
  if (!hasBotComment) {
    const signed = map.notSigned.length === 0;
    return { map, allSigned: signed, newSigned: [], comment: signed ? null : commentContent(false, map) };
  }
  const notSignedIds = new Set(map.notSigned.map((committer) => committer.id));
  const signing = comments.filter(signsTheCla);
  const newSigned = [];
  for (const comment of signing) {
    if (!notSignedIds.has(comment.userId) || newSigned.some((signature) => signature.id === comment.userId)) continue;
    newSigned.push({ name: comment.login, id: comment.userId, comment_id: comment.id, created_at: comment.createdAt, repoId, pullRequestNo: number });
  }
  const commented = committers.filter((committer) => signing.some((comment) => committer.id == comment.userId));
  const covered = [...commented, ...map.signed];
  const allSigned = committers.every((committer) => covered.some((signer) => committer.id === signer.id));
  const newIds = new Set(newSigned.map((signature) => signature.id));
  const after = {
    signed: [...map.signed, ...newSigned],
    notSigned: map.notSigned.filter((committer) => !newIds.has(committer.id)),
    unknown: map.unknown,
  };
  return { map: after, allSigned: allSigned || after.notSigned.length === 0, newSigned, comment: commentContent(allSigned, after) };
}

function nodesOf(connection) {
  return (connection && connection.nodes) || [];
}

function commentFacts(node) {
  return {
    id: Number(node.fullDatabaseId),
    createdAt: node.createdAt,
    body: node.body || "",
    login: commentLogin(node.author),
    bot: Boolean(node.author) && node.author.__typename === "Bot",
    userId: (node.author && node.author.databaseId) || null,
  };
}

async function readMore(github, query, variables, field, first) {
  const nodes = [...nodesOf(first)];
  let page = first && first.pageInfo;
  while (page && page.hasNextPage) {
    const data = await github.graphql(query, { ...variables, after: page.endCursor });
    const connection = data.repository.pullRequest[field];
    nodes.push(...nodesOf(connection));
    page = connection.pageInfo;
  }
  return nodes;
}

function signaturesExpression(config) {
  return `${config.branch}:${config.signaturesPath}`;
}

async function signatureFile(github, repo, blob, config) {
  if (!blob) return { sha: null, signedContributors: [] };
  let text = blob.text;
  if (blob.isTruncated || typeof text !== "string") {
    const { data } = await github.rest.repos.getContent({ ...repo, path: config.signaturesPath, ref: config.branch });
    text = Buffer.from(data.content, data.encoding || "base64").toString("utf8");
  }
  const parsed = JSON.parse(text);
  return { sha: blob.oid, signedContributors: parsed.signedContributors || [], content: parsed };
}

async function readPull(github, repo, number, config) {
  const variables = { owner: repo.owner, repo: repo.repo, number };
  const data = await github.graphql(CLA_QUERY, { ...variables, signatures: signaturesExpression(config) });
  const pull = data.repository.pullRequest;
  if (!pull) return null;
  const commits = await readMore(github, MORE_COMMITS_QUERY, variables, "commits", pull.commits);
  const comments = await readMore(github, MORE_COMMENTS_QUERY, variables, "comments", pull.comments);
  return {
    headSha: pull.headRefOid,
    headRef: pull.headRefName,
    headRepository: pull.headRepository ? pull.headRepository.nameWithOwner : null,
    commits: commits.map((node) => node.commit),
    comments: comments.map(commentFacts),
    file: await signatureFile(github, repo, data.repository.signatures, config),
  };
}

function signedCommitMessage(config, { actor, owner, repo, number }) {
  return config.signedMessage
    .replace("$contributorName", actor)
    .replace("$owner", owner)
    .replace("$repo", repo)
    .replace("$pullRequestNo", String(number));
}

async function writeSignatures(github, repo, file, newSigned, message, config) {
  const put = (current) => {
    const content = { ...(current.content || {}), signedContributors: [...current.signedContributors] };
    for (const signature of newSigned) {
      if (!content.signedContributors.some((known) => known.id === signature.id)) content.signedContributors.push(signature);
    }
    return github.rest.repos.createOrUpdateFileContents({
      ...repo,
      path: config.signaturesPath,
      message: current.sha ? message : config.createFileMessage,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
      branch: config.branch,
      ...(current.sha ? { sha: current.sha } : {}),
    });
  };
  try {
    await put(file);
  } catch (error) {
    if (![409, 422].includes(error.status)) throw error;
    const data = await github.graphql(SIGNATURES_QUERY, { owner: repo.owner, repo: repo.repo, signatures: signaturesExpression(config) });
    await put(await signatureFile(github, repo, data.repository.signatures, config));
  }
}

async function rerunFailedCheck(github, repo, pull, core, config) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: config.workflowFile,
    event: "pull_request_target",
    head_sha: pull.headSha,
    branch: pull.headRef,
    per_page: 20,
  });
  const ofThisPull = (run) =>
    run.head_branch === pull.headRef && Boolean(run.head_repository) && run.head_repository.full_name === pull.headRepository;
  const newest = (data.workflow_runs || []).find(ofThisPull);
  if (!newest || newest.conclusion !== "failure") return null;
  try {
    await github.rest.actions.reRunWorkflow({ ...repo, run_id: newest.id });
    return newest.id;
  } catch (error) {
    core.error(`Error occurred when re-running the workflow: ${error.message}`);
    return null;
  }
}

async function lock(github, repo, number, core) {
  core.info("Locking the Pull Request to safe guard the Pull Request CLA Signatures");
  try {
    await github.rest.issues.lock({ ...repo, issue_number: number });
    core.info(`successfully locked the pull request ${number}`);
  } catch {
    core.error("failed when locking the pull request ");
  }
}

async function check({ github, context, core, config }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const number = context.payload.pull_request ? context.payload.pull_request.number : context.payload.issue.number;
  const pull = await readPull(github, repo, number, config);
  if (!pull) {
    core.setFailed(`Pull request ${number} was not found`);
    return null;
  }
  const committers = committersOf(pull.commits, number, config.allowlist);
  const botComment = pull.comments.find((comment) => comment.login === WORKFLOW_BOT && BOT_MARKER.test(comment.body));
  const outcome = evaluate({
    committers,
    signedContributors: pull.file.signedContributors,
    comments: pull.comments,
    hasBotComment: Boolean(botComment),
    repoId: (context.payload.repository || {}).id,
    number,
  });
  if (outcome.comment !== null && (!botComment || botComment.body !== outcome.comment)) {
    if (botComment) await github.rest.issues.updateComment({ ...repo, comment_id: botComment.id, body: outcome.comment });
    else await github.rest.issues.createComment({ ...repo, issue_number: number, body: outcome.comment });
  }
  if (outcome.newSigned.length) {
    const message = signedCommitMessage(config, { actor: context.actor, owner: repo.owner, repo: repo.repo, number });
    await writeSignatures(github, repo, pull.file, outcome.newSigned, message, config);
  }
  if (!outcome.allSigned) {
    core.setFailed(`Committers of Pull Request number ${number} have to sign the CLA 📝`);
    return outcome;
  }
  core.info("All contributors have signed the CLA 📝 ✅ ");
  if (context.eventName === "issue_comment") await rerunFailedCheck(github, repo, pull, core, config);
  return outcome;
}

async function run({ github, context, core, config = CONFIG }) {
  if (context.eventName === "pull_request_target" && context.payload.action === "closed") {
    if (context.payload.pull_request.merged) await lock(github, context.repo, context.payload.pull_request.number, core);
    return null;
  }
  return check({ github, context, core, config });
}

module.exports = {
  CONFIG,
  allowlisted,
  committersOf,
  commentContent,
  evaluate,
  run,
};
