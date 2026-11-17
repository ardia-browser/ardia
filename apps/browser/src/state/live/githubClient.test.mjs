import assert from "node:assert/strict";
import { test } from "node:test";
import { createGithubClient, DETAILS_FRESH_MS, LIST_SHARED_MS } from "./githubClient.ts";
import { createGithubLimits, FALLBACK_COOLDOWN_MS, graphqlRateLimited, retryAtFromHeaders } from "./githubLimits.ts";
import { takeLiveGithubCounts } from "../telemetry/liveGithub.ts";

const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("./fixtures/github.json", import.meta.url), "utf8")));
const folder = { id: "f", filters: { authored: true, reviewRequests: true } };
const headers = (values = {}) => ({ get: (name) => values[name.toLowerCase()] ?? null });

function fakeGithub(clock) {
  const list = structuredClone(fixture);
  const all = () => [...list.data.authored.nodes, ...list.data.review.nodes];
  const calls = [];
  let quota = { limit: 5000, remaining: 4000, reset: Math.floor((clock.now + 3_600_000) / 1000) };
  let limitNext = null;
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const kind = query.includes("LiveFolderDetails") ? "details" : query.includes("LiveFolderGone") ? "gone" : query.includes("LiveFolder") ? "list" : "viewer";
    calls.push({ kind, ids: variables?.ids });
    const h = { "x-ratelimit-limit": String(quota.limit), "x-ratelimit-remaining": String(quota.remaining), "x-ratelimit-reset": String(quota.reset), "x-ratelimit-resource": "graphql" };
    if (limitNext) {
      const { status, extra } = limitNext;
      limitNext = null;
      return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status, headers: { ...h, ...extra } });
    }
    const body =
      kind === "list"
        ? list
        : kind === "details"
          ? { data: { nodes: variables.ids.map((id) => ({ ...all().find((n) => n.id === id), state: "OPEN" })) } }
          : { data: { viewer: { login: "me", name: null, avatarUrl: "" } } };
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  };
  return {
    list,
    calls,
    setQuota: (q) => (quota = { ...quota, ...q }),
    limitNext: (status, extra = {}) => (limitNext = { status, extra }),
    detailIds: () => calls.filter((c) => c.kind === "details").flatMap((c) => c.ids),
  };
}

const setup = () => {
  const clock = { now: 1_800_000_000_000 };
  const gh = fakeGithub(clock);
  const client = createGithubClient(() => clock.now);
  takeLiveGithubCounts();
  return { clock, gh, client };
};

test("unchanged pull requests keep their details; a changed one is read again", async () => {
  const { clock, gh, client } = setup();
  const first = await client.fetchFolder("t", folder, false);
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

test("a check finishing reads that pull request again even when its rollup state stays the same", async () => {
  const { clock, gh, client } = setup();
  const pr = gh.list.data.authored.nodes[0];
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.checkRunCountsByState = [{ state: "IN_PROGRESS", count: 2 }];
  await client.fetchFolder("t", folder, false);
  const before = gh.detailIds().length;
  clock.now += LIST_SHARED_MS;
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.checkRunCountsByState = [{ state: "IN_PROGRESS", count: 1 }, { state: "SUCCESS", count: 1 }];
  await client.fetchFolder("t", folder, false);
  assert.deepEqual(gh.detailIds().slice(before), [pr.id]);
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
