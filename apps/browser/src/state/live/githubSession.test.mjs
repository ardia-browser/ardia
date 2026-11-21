import assert from "node:assert/strict";
import { test } from "node:test";

const { mapPullsPage, PULLS_PAGE_SCRIPT } = await import("./githubSession.ts");

const authoredItem = (over = {}) => ({
  itemType: "pull_request",
  author: { displayLogin: "octofixture" },
  category: null,
  commentCount: 2,
  createdAt: "2026-11-01T10:00:00+00:00",
  displayState: "OPEN",
  headSha: "abc123",
  labels: [],
  id: "PR_kwDOFIXTURE1",
  isDraft: false,
  isReadByCurrentUser: true,
  number: 101,
  permalink: "https://github.com/fixtures-org/fixtures-repo/pull/101",
  repoNameWithOwner: "fixtures-org/fixtures-repo",
  state: "OPEN",
  title: "Fixture authored pull",
  updatedAt: "2026-11-14T10:00:00+00:00",
  ...over,
});

const reviewItem = (over = {}) =>
  authoredItem({
    id: "PR_kwDOFIXTURE2",
    number: 102,
    permalink: "https://github.com/fixtures-org/fixtures-repo/pull/102",
    title: "Fixture review pull",
    author: { displayLogin: "anotherfixture" },
    commentCount: null,
    category: "MERGE_CONFLICTS",
    ...over,
  });

const page = {
  signedOut: false,
  authored: [
    authoredItem(),
    authoredItem({ id: "PR_kwDOFIXTURE3", number: 103, title: "", permalink: "https://github.com/fixtures-org/fixtures-repo/pull/103" }),
  ].map(slimResult),
  reviewRequested: [slimResult(reviewItem())],
  deferred: [
    { id: "PR_kwDOFIXTURE1", review: "REVIEW_REQUIRED" },
    { id: "PR_kwDOFIXTURE2", review: "CHANGES_REQUESTED" },
  ],
};

function slimResult(r) {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    url: r.permalink,
    repo: r.repoNameWithOwner,
    author: r.author && r.author.displayLogin,
    updatedAt: r.updatedAt,
    draft: !!r.isDraft,
    comments: r.commentCount == null ? null : r.commentCount,
    category: r.category || null,
    labels: (Array.isArray(r.labels) ? r.labels : [])
      .map((l) => (l && typeof l === "object" ? { name: l.name, color: l.color } : null))
      .filter((l) => l && typeof l.name === "string" && typeof l.color === "string"),
  };
}

test("a signed-in page maps authored and review-requested sections", () => {
  const items = mapPullsPage(page, { authored: true, reviewRequests: true });
  assert.equal(items.length, 2);
  const first = items[0];
  assert.deepEqual(
    [first.id, first.source, first.url, first.title, first.subtitle, first.section, first.updatedAt],
    ["github:PR_kwDOFIXTURE1", "github", "https://github.com/fixtures-org/fixtures-repo/pull/101", "Fixture authored pull", "fixtures-org/fixtures-repo #101", "authored", Date.parse("2026-11-14T10:00:00+00:00")],
  );
  assert.deepEqual(
    { ...first.pr, checks: [] },
    {
      number: 101,
      repo: "fixtures-org/fixtures-repo",
      author: "octofixture",
      authorAvatar: "https://github.com/octofixture.png?size=64",
      draft: false,
      headRef: "",
      baseRef: "",
      review: "required",
      mergeable: "unknown",
      checks: [],
      comments: 2,
      unresolvedThreads: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      labels: [],
    },
  );
  const review = items[1];
  assert.equal(review.section, "review");
  assert.equal(review.pr.author, "anotherfixture");
  assert.equal(review.pr.authorAvatar, "https://github.com/anotherfixture.png?size=64");
  assert.equal(review.pr.comments, null);
  assert.equal(review.pr.mergeable, "conflicting");
  assert.equal(review.pr.review, "changesRequested");
});

test("sections honour the folder filters", () => {
  assert.equal(mapPullsPage(page, { authored: false, reviewRequests: true })[0].section, "review");
  assert.equal(mapPullsPage(page, { authored: false, reviewRequests: true }).length, 1);
  assert.equal(mapPullsPage(page, { authored: true, reviewRequests: false }).length, 1);
  assert.equal(mapPullsPage(page, { authored: false, reviewRequests: false }).length, 0);
});

test("an item on both sections appears once, in authored", () => {
  const both = { ...page, reviewRequested: [...page.reviewRequested, page.authored[0]] };
  const items = mapPullsPage(both, { authored: true, reviewRequests: true });
  assert.equal(items.length, 2);
});

test("a signed-out page, an errored page and an unknown shape read as empty", () => {
  assert.deepEqual(mapPullsPage({ signedOut: true, authored: page.authored }, { authored: true, reviewRequests: true }), []);
  assert.deepEqual(mapPullsPage({ signedOut: false, error: "shape changed", authored: [], reviewRequested: [], deferred: [] }, { authored: true, reviewRequests: true }), []);
  assert.deepEqual(mapPullsPage({}, { authored: true, reviewRequests: true }), []);
});

test("the extractor script is the wrapped function the engine evaluates", () => {
  assert.ok(PULLS_PAGE_SCRIPT.startsWith("post('result',"));
  assert.doesNotThrow(() => new Function("post", "document", "XMLHttpRequest", PULLS_PAGE_SCRIPT));
});

function runScript(fixtures, userLogin) {
  const document = { querySelector: () => (userLogin ? { content: userLogin } : null) };
  class FakeXHR {
    open(method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      const hit = fixtures[this.url] ?? fixtures[this.url.split("?")[0]];
      this.status = hit ? 200 : 404;
      this.responseText = hit ? JSON.stringify(hit) : "";
      this.responseURL = hit ? "https://github.com" + this.url : "https://github.com/login";
    }
  }
  let posted;
  const post = (kind, json) => (posted = JSON.parse(json));
  new Function("post", "document", "XMLHttpRequest", PULLS_PAGE_SCRIPT)(post, document, FakeXHR);
  return posted;
}

const dashboard = (results, totalPages = 1, currentPage = 1) => ({ payload: { pullsDashboardSurfaceContentRoute: { results, pageInfo: { currentPage, totalPages, totalCount: results.length } } } });
const deferredJson = (results) => ({ payload: { pullsInboxSurfaceContentDeferredData: { results } } });
const inboxJson = (results) => ({ payload: { pullsInboxSurfaceContentRoute: { results } } });

test("the script reads the JSON endpoints and returns slim sections", () => {
  const posted = runScript(
    {
      "/pulls/authored": dashboard([authoredItem()]),
      "/pulls/reviews": dashboard([reviewItem()]),
      "/pulls/inbox/deferred": deferredJson([{ id: "PR_kwDOFIXTURE1", reviewDecisionState: "REVIEW_REQUIRED" }, { id: "PR_kwDOFIXTURE2", reviewDecisionState: "APPROVED" }]),
    },
    "octofixture",
  );
  assert.equal(posted.signedOut, false);
  assert.equal(posted.login, "octofixture");
  assert.deepEqual(posted.reviewRequested, [slimResult(reviewItem())]);
  assert.deepEqual(posted.deferred, [
    { id: "PR_kwDOFIXTURE1", review: "REVIEW_REQUIRED" },
    { id: "PR_kwDOFIXTURE2", review: "APPROVED" },
  ]);
  const items = mapPullsPage(posted, { authored: true, reviewRequests: true });
  assert.equal(items[0].pr.review, "required");
  assert.equal(items[1].pr.review, "approved");
});

test("the script reports signed out without the user-login meta", () => {
  assert.deepEqual(runScript({ "/pulls/authored": dashboard([]) }, null), { signedOut: true });
});

test("the script reports signed out when the authored request hits the login redirect", () => {
  const document = { querySelector: () => ({ content: "octofixture" }) };
  class LoginXHR {
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = "<html></html>";
      this.responseURL = "https://github.com/login";
    }
  }
  let posted;
  const post = (kind, json) => (posted = JSON.parse(json));
  new Function("post", "document", "XMLHttpRequest", PULLS_PAGE_SCRIPT)(post, document, LoginXHR);
  assert.deepEqual(posted, { signedOut: true });
});

test("a broken payload shape returns empty sections instead of throwing", () => {
  const posted = runScript(
    {
      "/pulls/authored": { payload: {} },
      "/pulls/reviews": { payload: { pullsDashboardSurfaceContentRoute: { results: null } } },
      "/pulls/inbox/deferred": { payload: null },
    },
    "octofixture",
  );
  assert.equal(posted.signedOut, false);
  assert.deepEqual(posted.authored, []);
  assert.deepEqual(posted.reviewRequested, []);
  assert.deepEqual(posted.deferred, []);
});

const pageItem = (n) => authoredItem({ id: `PR_kwDOFIXTUREP${n}`, number: 200 + n, permalink: `https://github.com/fixtures-org/fixtures-repo/pull/${200 + n}`, title: `Fixture page pull ${n}` });

test("the script pages through dashboard results until totalPages", () => {
  const posted = runScript(
    {
      "/pulls/authored": dashboard([pageItem(1)], 3, 1),
      "/pulls/authored?page=2": dashboard([pageItem(2)], 3, 2),
      "/pulls/authored?page=3": dashboard([pageItem(3)], 3, 3),
      "/pulls/reviews": dashboard([reviewItem()], 2, 1),
      "/pulls/reviews?page=2": dashboard([reviewItem({ id: "PR_kwDOFIXTURE9", number: 109, permalink: "https://github.com/fixtures-org/fixtures-repo/pull/109" })], 2, 2),
      "/pulls/inbox/deferred": deferredJson([]),
    },
    "octofixture",
  );
  assert.deepEqual(posted.authored.map((r) => r.id), ["PR_kwDOFIXTUREP1", "PR_kwDOFIXTUREP2", "PR_kwDOFIXTUREP3"]);
  assert.equal(posted.reviewRequested.length, 2);
});

test("the script stops paging without pageInfo and caps at four pages", () => {
  const pages = {};
  for (let page = 1; page <= 6; page++) {
    pages[page === 1 ? "/pulls/authored" : `/pulls/authored?page=${page}`] = { payload: { pullsDashboardSurfaceContentRoute: { results: [pageItem(page)], pageInfo: { currentPage: page, totalPages: 99 } } } };
  }
  pages["/pulls/reviews"] = dashboard([]);
  const posted = runScript(pages, "octofixture");
  assert.equal(posted.authored.length, 4);
  assert.deepEqual(posted.reviewRequested, []);
});

test("the script collects merge conflicts from the two inbox filters", () => {
  const posted = runScript(
    {
      "/pulls/authored": dashboard([authoredItem()]),
      "/pulls/reviews": dashboard([reviewItem({ category: null })]),
      "/pulls/inbox/queries?filter=waiting-for-review&max_pr_age=1m": inboxJson([
        { id: "PR_kwDOFIXTURE1", category: "MERGE_CONFLICTS" },
        { id: "PR_kwDOFIXTUREX", category: "NEEDS_REVIEW" },
      ]),
      "/pulls/inbox/queries?filter=ready-to-merge&max_pr_age=1m": inboxJson([{ id: "PR_kwDOFIXTURE2", category: "MERGE_CONFLICTS" }]),
    },
    "octofixture",
  );
  assert.deepEqual(posted.conflicts, ["PR_kwDOFIXTURE1", "PR_kwDOFIXTURE2"]);
  const items = mapPullsPage(posted, { authored: true, reviewRequests: true });
  assert.equal(items[0].pr.mergeable, "conflicting");
  assert.equal(items[1].pr.mergeable, "conflicting");
});

test("labels map through and malformed labels are skipped", () => {
  const posted = runScript(
    {
      "/pulls/authored": dashboard([
        authoredItem({ labels: [{ name: "bug", color: "ff0000" }, { name: "ui", color: "#00ff00" }, null, { name: 5, color: "000000" }, { name: "no-color" }, "junk"] }),
      ]),
      "/pulls/reviews": dashboard([]),
    },
    "octofixture",
  );
  assert.deepEqual(posted.authored[0].labels, [
    { name: "bug", color: "ff0000" },
    { name: "ui", color: "#00ff00" },
  ]);
  const items = mapPullsPage(posted, { authored: true, reviewRequests: true });
  assert.deepEqual(items[0].pr.labels, [
    { name: "bug", color: "ff0000" },
    { name: "ui", color: "#00ff00" },
  ]);
});
