import assert from "node:assert/strict";
import { test } from "node:test";
import { createGithubClient, DETAILS_FRESH_MS, LIST_SHARED_MS, PENDING_FRESH_MS } from "./githubClient.ts";
import { createGithubLimits, FALLBACK_COOLDOWN_MS, graphqlRateLimited, retryAtFromHeaders } from "./githubLimits.ts";
import { takeLiveGithubCounts } from "../telemetry/liveGithub.ts";
import { setConsentPeriod } from "../telemetry/consentPeriod.ts";
import { request } from "./net.ts";
import { LiveError } from "./types.ts";

const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("./fixtures/github.json", import.meta.url), "utf8")));
const folder = { id: "f", filters: { authored: true, reviewRequests: true } };
const headers = (values = {}) => ({ get: (name) => values[name.toLowerCase()] ?? null });
const searchKey = (q) => (q.includes("user-review-requested") ? "direct" : q.includes("review-requested") ? "review" : "authored");
const searchAnswer = (data, variables, extra = {}) => ({ data: { ...extra, search: { nodes: data[searchKey(variables.q)].nodes } } });
const queryKind = (query, variables) =>
  query.includes("LiveFolderDetails") ? "details" : query.includes("LiveFolderGone") ? "gone" : query.includes("search(") ? (searchKey(variables.q) === "authored" ? "list" : "search") : "viewer";

function fakeGithub(clock) {
  const list = structuredClone(fixture);
  const all = () => [...list.data.authored.nodes, ...list.data.review.nodes];
  const calls = [];
  let quota = { limit: 5000, remaining: 4000, reset: Math.floor((clock.now + 3_600_000) / 1000) };
  let limitNext = null;
  const restFailures = new Map();
  const emptyRest = new Set();
  let blockedSearch = null;
  const blockedKeys = new Map();
  const hidden = new Set();
  const hiddenBySearch = new Map();
  const closed = new Set();
  const restIssue = (n) => ({
    node_id: n.id,
    number: n.number,
    title: n.title,
    html_url: n.url,
    updated_at: n.updatedAt,
    draft: n.isDraft,
    comments: n.comments.totalCount,
    user: n.author ? { login: n.author.login, avatar_url: n.author.avatarUrl } : null,
    repository_url: `https://api.github.com/repos/${n.repository.nameWithOwner}`,
    pull_request: { merged_at: null },
  });
  const restItems = (key) => {
    const rows = key === "direct" ? list.data.direct.nodes.map((d) => all().find((n) => n?.id === d.id)) : list.data[key].nodes;
    return rows.filter((n) => n && n.number).map(restIssue);
  };
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/search/issues")) {
      const key = searchKey(new URL(href).searchParams.get("q") ?? "");
      calls.push({ kind: "rest", key });
      const failure = restFailures.get(key);
      if (failure) {
        restFailures.delete(key);
        const { status, extra } = failure;
        return new Response(JSON.stringify({ message: "Server Error" }), { status, headers: extra });
      }
      const items = emptyRest.has(key) ? [] : restItems(key);
      const restHeaders = { "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29", "x-ratelimit-reset": String(quota.reset) };
      return new Response(JSON.stringify({ total_count: items.length, incomplete_results: false, items }), { status: 200, headers: restHeaders });
    }
    const { query, variables } = JSON.parse(init.body);
    const kind = queryKind(query, variables);
    calls.push({ kind, ids: variables?.ids });
    const h = { "x-ratelimit-limit": String(quota.limit), "x-ratelimit-remaining": String(quota.remaining), "x-ratelimit-reset": String(quota.reset), "x-ratelimit-resource": "graphql" };
    if (limitNext) {
      const { status, extra } = limitNext;
      limitNext = null;
      return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status, headers: { ...h, ...extra } });
    }
    const errors = blockedKeys.get(searchKey(variables?.q ?? "")) ?? (blockedSearch && kind === blockedSearch.kind ? blockedSearch.errors : null);
    const body =
      kind === "list" || kind === "search"
        ? { ...searchAnswer(list.data, variables), ...(errors ? { errors } : {}) }
        : kind === "details"
          ? { data: { nodes: variables.ids.map((id) => ({ ...all().find((n) => n?.id === id), state: closed.has(id) ? "MERGED" : "OPEN" })) } }
          : { data: { viewer: { login: "me", name: null, avatarUrl: "" } } };
    if (body.data?.search) {
      const hiddenHere = hiddenBySearch.get(searchKey(variables.q));
      body.data.search.nodes = body.data.search.nodes.map((n) => (n && (hidden.has(n.id) || hiddenHere?.has(n.id)) ? null : n));
    }
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  };
  return {
    list,
    calls,
    closed,
    setQuota: (q) => (quota = { ...quota, ...q }),
    limitNext: (status, extra = {}) => (limitNext = { status, extra }),
    failRestKey: (key, status, extra = {}) => restFailures.set(key, { status, extra }),
    restEmpty: (key) => emptyRest.add(key),
    blockSearch: (kind, errors) => (blockedSearch = { kind, errors }),
    blockKeys: (keys, errors) => keys.forEach((key) => blockedKeys.set(key, errors)),
    hide: (id) => hidden.add(id),
    hideFrom: (key, id) => hiddenBySearch.set(key, new Set([id])),
    restKeys: () => calls.filter((c) => c.kind === "rest").map((c) => c.key),
    detailIds: () => calls.filter((c) => c.kind === "details").flatMap((c) => c.ids),
  };
}

const sendThroughFetch = (token, payload, onHeaders) =>
  request("https://api.github.test/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }, onHeaders);

const restThroughFetch = (token, q, onHeaders) =>
  request(`https://api.github.test/search/issues?per_page=50&sort=updated&order=desc&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } }, onHeaders);

const settleAll = (gh) => {
  for (const n of [...gh.list.data.authored.nodes, ...gh.list.data.review.nodes]) n.commits.nodes[0].commit.statusCheckRollup = { state: "SUCCESS", contexts: { nodes: [] } };
};

const setup = (send = sendThroughFetch) => {
  const clock = { now: 1_800_000_000_000 };
  const gh = fakeGithub(clock);
  const client = createGithubClient(send, () => clock.now, undefined, restThroughFetch);
  takeLiveGithubCounts();
  return { clock, gh, client };
};

const CLASSIC = "`acme` forbids access via a personal access token (classic). Please use a GitHub App, OAuth App, or a personal access token with fine-grained permissions.";
const classicError = { type: "FORBIDDEN", message: CLASSIC, path: ["search", "nodes", 0] };

test("unchanged pull requests keep their details; a changed one is read again", async () => {
  const { clock, gh, client } = setup();
  const first = await client.fetchFolder("t", folder, false);
  assert.deepEqual(gh.restKeys(), []);
  const ids = gh.detailIds();
  assert.equal(ids.length, new Set(first.map((it) => it.id)).size);
  clock.now += LIST_SHARED_MS;
  gh.list.data.authored.nodes[0].updatedAt = "2099-01-01T00:00:00Z";
  gh.list.data.authored.nodes[0].title = "Renamed";
  const second = await client.fetchFolder("t", folder, false);
  assert.deepEqual(gh.detailIds().slice(ids.length), [gh.list.data.authored.nodes[0].id]);
  assert.equal(second.find((it) => it.id === `github:${gh.list.data.authored.nodes[0].id}`).title, "Renamed");
  assert.equal(second.length, first.length);
  const counts = takeLiveGithubCounts();
  assert.equal(counts.live_github_details_fetched, ids.length + 1);
  assert.equal(counts.live_github_details_reused, ids.length - 1);
});

test("a pull request with checks still running is read again after a minute; a settled one waits for a change", async () => {
  const { clock, gh, client } = setup();
  const [running, settled] = gh.list.data.authored.nodes;
  settled.commits.nodes[0].commit.statusCheckRollup = { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }] } };
  running.commits.nodes[0].commit.statusCheckRollup = { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: null }] } };
  await client.fetchFolder("t", folder, false);
  const before = gh.detailIds().length;
  clock.now += PENDING_FRESH_MS;
  await client.fetchFolder("t", folder, false);
  const reread = gh.detailIds().slice(before);
  assert.ok(reread.includes(running.id));
  assert.ok(!reread.includes(settled.id));
});

test("a new head commit or a settled rollup reads that pull request again", async () => {
  const { clock, gh, client } = setup();
  const [pushed, finished] = gh.list.data.authored.nodes;
  await client.fetchFolder("t", folder, false);
  const before = gh.detailIds().length;
  clock.now += LIST_SHARED_MS;
  pushed.headRefOid = "new-head";
  finished.commits.nodes[0].commit.statusCheckRollup.state = "FAILURE";
  await client.fetchFolder("t", folder, false);
  assert.deepEqual(gh.detailIds().slice(before).sort(), [pushed.id, finished.id].sort());
});

test("the listing's three searches go out side by side, not one after another", async () => {
  const { gh, client } = setup();
  let inFlight = 0;
  let peak = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return fetch(url, init);
  };
  await client.fetchFolder("t", folder, true);
  assert.equal(gh.calls.filter((c) => c.kind === "list" || c.kind === "search").length, 3);
  assert.ok(peak >= 3);
});

test("pull requests an organization's token policy hides drop out and the folder says why; the rest still show", async () => {
  const { gh, client } = setup();
  const message = "The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days. Please adjust your token's lifetime at the following URL: https://github.com/settings/personal-access-tokens/1";
  gh.list.data.authored.nodes[0] = null;
  gh.blockSearch("list", [{ type: "FORBIDDEN", message, path: ["search", "nodes", 0] }]);
  setConsentPeriod(true, "github-blocked-test");
  const items = await client.fetchFolder("t", folder, true);
  setConsentPeriod(false, null);
  assert.ok(items.length > 0);
  assert.deepEqual(gh.restKeys(), []);
  assert.equal(client.warning()?.kind, "tokenBlocked");
  assert.equal(client.warning()?.message, message);
  assert.equal(takeLiveGithubCounts().live_github_blocked_listings, 1);
});

test("a fallback listing that started while sharing was off is not counted", async () => {
  const { gh, client } = setup();
  gh.hide(gh.list.data.authored.nodes[0].id);
  gh.blockKeys(["authored"], [classicError]);
  setConsentPeriod(false, null);
  const listing = client.fetchFolder("t", folder, true);
  setConsentPeriod(true, "github-blocked-late-test");
  await listing;
  setConsentPeriod(false, null);
  assert.deepEqual(gh.restKeys(), ["authored"]);
  const counts = takeLiveGithubCounts();
  assert.equal(counts.live_github_blocked_listings, 0);
  assert.equal(counts.live_github_rest_fallbacks, 0);
});

test("a listing GitHub hides entirely for SAML says Single Sign-On, and clears once access comes back", async () => {
  const { clock, gh, client } = setup();
  const full = structuredClone(gh.list.data);
  for (const key of ["authored", "review", "direct"]) gh.list.data[key].nodes = gh.list.data[key].nodes.map(() => null);
  gh.blockSearch("list", [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.", path: ["search", "nodes", 0] }]);
  assert.deepEqual(await client.fetchFolder("t", folder, true), []);
  assert.equal(client.warning()?.kind, "sso");
  Object.assign(gh.list.data, full);
  gh.blockSearch(null, []);
  clock.now += LIST_SHARED_MS;
  assert.ok((await client.fetchFolder("t", folder, false)).length > 0);
  assert.equal(client.warning(), null);
});

test("details older than the freshness window are read again even when nothing changed", async () => {
  const { clock, gh, client } = setup();
  await client.fetchFolder("t", folder, false);
  const before = gh.detailIds().length;
  clock.now += DETAILS_FRESH_MS;
  await client.fetchFolder("t", folder, false);
  assert.equal(gh.detailIds().length, before * 2);
});

test("folders refreshing together share one list request", async () => {
  const { clock, gh, client } = setup();
  await Promise.all([client.fetchFolder("t", folder, false), client.fetchFolder("t", { ...folder, id: "g" }, false)]);
  await client.fetchFolder("t", folder, false);
  assert.equal(gh.calls.filter((c) => c.kind === "list").length, 1);
  assert.equal(new Set(gh.detailIds()).size, gh.detailIds().length);
  await client.fetchFolder("t", folder, true);
  assert.equal(gh.calls.filter((c) => c.kind === "list").length, 2);
  clock.now += LIST_SHARED_MS;
  await client.fetchFolder("t", folder, false);
  assert.equal(gh.calls.filter((c) => c.kind === "list").length, 3);
});

test("background refreshes stop at the last tenth of the quota; a manual refresh still goes", async () => {
  const { clock, gh, client } = setup();
  await client.fetchFolder("t", folder, false);
  gh.setQuota({ remaining: 499 });
  await client.fetchFolder("t", folder, true);
  const sent = gh.calls.length;
  clock.now += LIST_SHARED_MS;
  await assert.rejects(client.fetchFolder("t", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(gh.calls.length, sent);
  assert.ok(client.pausedUntil() > clock.now);
  await client.fetchFolder("t", folder, true);
  assert.ok(gh.calls.length > sent);
  assert.ok(takeLiveGithubCounts().live_github_requests_held >= 1);
});

test("a secondary rate limit pauses background reads until Retry-After, without signing out", async () => {
  const { clock, gh, client } = setup();
  gh.limitNext(403, { "retry-after": "120" });
  await assert.rejects(client.fetchFolder("t", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(client.pausedUntil(), clock.now + 120_000);
  const sent = gh.calls.length;
  clock.now += 60_000;
  await assert.rejects(client.fetchFolder("t", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(gh.calls.length, sent);
  clock.now += 60_000;
  await client.fetchFolder("t", folder, false);
  assert.equal(client.pausedUntil(), null);
});

test("pauses without a reset time back off from 30 seconds, doubling", () => {
  const clock = { now: 0 };
  const limits = createGithubLimits(() => clock.now);
  limits.rateLimited("t");
  assert.equal(limits.blockedUntil("t", false), FALLBACK_COOLDOWN_MS);
  clock.now = FALLBACK_COOLDOWN_MS;
  limits.rateLimited("t");
  assert.equal(limits.blockedUntil("t", false), clock.now + 2 * FALLBACK_COOLDOWN_MS);
  assert.equal(limits.blockedUntil("t", true), null);
  assert.equal(limits.blockedUntil("other", false), null);
});

test("an exhausted quota holds manual refreshes too, until it resets", () => {
  const clock = { now: 0 };
  const limits = createGithubLimits(() => clock.now);
  limits.observe("t", headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }));
  assert.equal(limits.blockedUntil("t", true), 60_000);
  clock.now = 60_000;
  assert.equal(limits.blockedUntil("t", true), null);
});

test("only a few requests run at once", async () => {
  const limits = createGithubLimits(Date.now, 2);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limits.withSlot(async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test("rate limit answers are recognised the way GitHub sends them", () => {
  assert.equal(graphqlRateLimited([{ type: "RATE_LIMITED", message: "x" }], null), true);
  assert.equal(graphqlRateLimited([{ message: "API rate limit already exceeded for user ID 1." }], null), true);
  assert.equal(graphqlRateLimited([{ type: "NOT_FOUND", message: "gone" }], headers({ "x-ratelimit-remaining": "10" })), false);
  assert.equal(retryAtFromHeaders(headers({ "retry-after": "5" }), 1000), 6000);
  assert.equal(retryAtFromHeaders(headers({ "x-ratelimit-reset": "100" }), 1000), 100_000);
  assert.equal(retryAtFromHeaders(null, 1000), undefined);
});

test("a refresh with nothing changed hands back the very same items, stacked ones included", async () => {
  const { clock, gh, client } = setup();
  const [base, top] = gh.list.data.authored.nodes;
  top.baseRefName = base.headRefName;
  top.repository = base.repository;
  top.updatedAt = "2099-01-01T00:00:00Z";
  const first = await client.fetchFolder("t", folder, false);
  assert.ok(first.some((it) => it.pr?.stack));
  clock.now += LIST_SHARED_MS;
  const second = await client.fetchFolder("t", folder, false);
  assert.equal(second.length, first.length);
  second.forEach((it, i) => assert.equal(it, first[i]));
  clock.now += DETAILS_FRESH_MS;
  const third = await client.fetchFolder("t", folder, false);
  third.forEach((it, i) => assert.equal(it, first[i]));
});

test("a pull request that closed between the search and its details drops out", async () => {
  const { gh, client } = setup();
  const id = gh.list.data.authored.nodes[1].id;
  gh.closed.add(id);
  const items = await client.fetchFolder("t", folder, true);
  assert.ok(!items.some((it) => it.id === `github:${id}`));
  assert.ok(items.length > 0);
});

test("details of pull requests that left the search are let go, and a new account starts clean", async () => {
  const { clock, gh, client } = setup();
  settleAll(gh);
  await client.fetchFolder("t", folder, false);
  const before = gh.detailIds().length;
  const gone = gh.list.data.authored.nodes.shift();
  clock.now += LIST_SHARED_MS;
  await client.fetchFolder("t", folder, false);
  gh.list.data.authored.nodes.unshift(gone);
  clock.now += LIST_SHARED_MS;
  await client.fetchFolder("t", folder, false);
  assert.deepEqual(gh.detailIds().slice(before), [gone.id]);
  const total = gh.detailIds().length;
  await client.fetchFolder("other", folder, false);
  assert.equal(gh.detailIds().length, total + before);
});

test("without headers (Linux's host) the quota comes from the answer's rateLimit", async () => {
  const clock = { now: 1_800_000_000_000 };
  const reset = new Date(clock.now + 3_600_000).toISOString();
  let remaining = 4000;
  const calls = [];
  const send = async (_scope, { query, variables }) => {
    calls.push(query);
    const rateLimit = { limit: 5000, remaining, resetAt: reset };
    if (query.includes("LiveFolderDetails")) return { data: { rateLimit, nodes: variables.ids.map((id) => ({ ...[...fixture.data.authored.nodes, ...fixture.data.review.nodes].find((n) => n.id === id), state: "OPEN" })) } };
    return searchAnswer(structuredClone(fixture).data, variables, { rateLimit });
  };
  const client = createGithubClient(send, () => clock.now);
  await client.fetchFolder("host", folder, false);
  remaining = 100;
  clock.now += LIST_SHARED_MS;
  await client.fetchFolder("host", folder, true);
  const sent = calls.length;
  clock.now += LIST_SHARED_MS;
  await assert.rejects(client.fetchFolder("host", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(calls.length, sent);
  assert.equal(client.pausedUntil(), Date.parse(reset));
});

test("a rate limit the host reports pauses background reads with the fallback backoff", async () => {
  const clock = { now: 0 };
  let fail = true;
  const send = async (_scope, { variables }) => {
    if (fail) throw new LiveError("rateLimited", "host says slow down");
    return searchAnswer(structuredClone(fixture).data, variables);
  };
  const client = createGithubClient(send, () => clock.now);
  await assert.rejects(client.fetchFolder("host", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(client.pausedUntil(), FALLBACK_COOLDOWN_MS);
  clock.now = FALLBACK_COOLDOWN_MS;
  await assert.rejects(client.fetchFolder("host", folder, false), (e) => e.kind === "rateLimited");
  assert.equal(client.pausedUntil(), FALLBACK_COOLDOWN_MS * 3);
  fail = false;
  await assert.rejects(client.fetchFolder("host", folder, false), (e) => e.kind === "rateLimited");
});

test("a classic token policy falls back to the search API and the folder stops warning", async () => {
  const { gh, client } = setup();
  const authored = gh.list.data.authored.nodes;
  for (const n of authored) gh.hide(n.id);
  gh.blockKeys(["authored"], [classicError]);
  setConsentPeriod(true, "github-rest-test");
  const items = await client.fetchFolder("t", folder, true);
  setConsentPeriod(false, null);
  assert.deepEqual(gh.restKeys(), ["authored"]);
  const restored = items.filter((it) => it.section === "authored");
  assert.deepEqual(restored.map((it) => [it.id, it.title, it.pr.repo]), authored.map((n) => [`github:${n.id}`, n.title, n.repository.nameWithOwner]));
  assert.ok(restored.every((it) => !it.pr.stack && !it.pr.checks.length && it.pr.review === null && it.pr.mergeable === "unknown"));
  assert.equal(client.warning(), null);
  assert.ok(!gh.detailIds().some((id) => authored.some((n) => n.id === id)));
  const counts = takeLiveGithubCounts();
  assert.equal(counts.live_github_rest_fallbacks, 1);
  assert.equal(counts.live_github_rest_recovered, authored.length);
  assert.equal(counts.live_github_rest_failed, 0);
  assert.equal(counts.live_github_blocked_listings, 1);
});

test("mixed GraphQL and REST results keep one row per PR, full details, and direct review membership", async () => {
  const { gh, client } = setup();
  const [recovered, kept] = gh.list.data.review.nodes;
  gh.list.data.direct.nodes.push({ id: kept.id });
  gh.hideFrom("review", recovered.id);
  gh.hideFrom("direct", kept.id);
  gh.blockKeys(["review", "direct"], [classicError]);
  const items = await client.fetchFolder("t", folder, true);
  assert.deepEqual(gh.restKeys(), ["review", "direct"]);
  const reviewed = items.filter((it) => it.section === "review" || it.section === "team");
  assert.deepEqual(new Set(reviewed.map((it) => it.id)), new Set([`github:${recovered.id}`, `github:${kept.id}`]));
  assert.equal(reviewed.length, 2);
  assert.ok(reviewed.every((it) => it.section === "review"));
  assert.equal(reviewed.find((it) => it.id === `github:${kept.id}`).pr.headRef, kept.headRefName);
  assert.ok(!gh.detailIds().includes(recovered.id));
  assert.equal(client.warning(), null);
});

test("an older GraphQL details response cannot erase a newly recovered pull request", async () => {
  const started = Promise.withResolvers();
  const details = Promise.withResolvers();
  const { gh, client } = setup((token, payload, onHeaders) => {
    if (!payload.query.includes("LiveFolderDetails")) return sendThroughFetch(token, payload, onHeaders);
    started.resolve();
    return details.promise;
  });
  const [pr] = gh.list.data.authored.nodes;
  gh.list.data.authored.nodes = [pr];
  const authoredOnly = { ...folder, filters: { authored: true, reviewRequests: false } };
  const older = client.fetchFolder("t", authoredOnly, true);
  await started.promise;
  gh.hide(pr.id);
  gh.blockKeys(["authored"], [classicError]);
  const recovered = await client.fetchFolder("t", authoredOnly, true);
  details.resolve({ data: { nodes: [null] }, errors: [{ ...classicError, path: ["nodes", 0] }] });
  await older;
  assert.deepEqual(recovered.map((it) => it.id), [`github:${pr.id}`]);
  assert.deepEqual(await client.fetchFolder("t", authoredOnly, false), recovered);
});

test("a SAML block still shows after the search API recovers the rest", async () => {
  const { gh, client } = setup();
  for (const n of gh.list.data.authored.nodes) gh.hide(n.id);
  const saml = { type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.", path: ["search", "nodes", 0] };
  gh.blockKeys(["authored"], [classicError, saml]);
  await client.fetchFolder("t", folder, true);
  assert.equal(client.warning()?.kind, "sso");
});

test("a rate limit on the search API pauses only that API, until its Retry-After", async () => {
  const { clock, gh, client } = setup();
  for (const n of gh.list.data.authored.nodes) gh.hide(n.id);
  gh.blockKeys(["authored"], [classicError]);
  gh.failRestKey("authored", 429, { "retry-after": "120" });
  await client.fetchFolder("t", folder, false);
  assert.equal(client.warning()?.kind, "tokenBlocked");
  const sent = gh.restKeys().length;
  clock.now += LIST_SHARED_MS;
  await client.fetchFolder("t", folder, false);
  assert.equal(gh.restKeys().length, sent);
  clock.now += 120_000;
  await client.fetchFolder("t", folder, false);
  assert.ok(gh.restKeys().length > sent);
});

test("recovering one search keeps the warning for another search that failed or found nothing", async () => {
  const { gh, client } = setup();
  for (const n of [...gh.list.data.authored.nodes, ...gh.list.data.review.nodes]) gh.hide(n.id);
  gh.blockKeys(["authored", "review"], [classicError]);
  gh.failRestKey("review", 500);
  gh.restEmpty("review");
  setConsentPeriod(true, "github-rest-partial");
  try {
    for (const failed of [1, 0]) {
      const items = await client.fetchFolder("t", folder, true);
      assert.equal(client.warning()?.kind, "tokenBlocked");
      assert.ok(items.length > 0 && items.every((it) => it.section === "authored"));
      const counts = takeLiveGithubCounts();
      assert.equal(counts.live_github_rest_failed, failed);
      assert.equal(counts.live_github_rest_recovered, gh.list.data.authored.nodes.length);
    }
  } finally {
    setConsentPeriod(false, null);
  }
});
