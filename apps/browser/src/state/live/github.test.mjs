import assert from "node:assert/strict";
import { test } from "node:test";
import { detailNodes, listingOf, mapGithub, sectioned } from "./github.ts";
import { LiveError } from "./types.ts";

const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("./fixtures/github.json", import.meta.url), "utf8")));
const all = [...fixture.data.authored.nodes, ...fixture.data.review.nodes];
const pr = (id) => ({ ...all.find((n) => n.id === id), state: "OPEN" });
const filters = { authored: true, reviewRequests: true };
const kind = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LiveError);
    return error.kind;
  }
  return "ok";
};

test("a page without errors returns every PR", () => {
  const ids = all.slice(0, 3).map((n) => n.id);
  assert.deepEqual(detailNodes(ids, { data: { nodes: ids.map(pr) } }).map((n) => n.id), ids);
});

test("a field error keeps the PR, with that field empty", () => {
  const ids = all.slice(0, 2).map((n) => n.id);
  const nodes = ids.map(pr);
  nodes[1] = { ...nodes[1], commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
  const errors = [{ type: "FORBIDDEN", message: "no checks", path: ["nodes", 1, "commits", "nodes", 0, "commit", "statusCheckRollup"] }];
  const kept = detailNodes(ids, { data: { nodes }, errors });
  assert.deepEqual(kept.map((n) => n.id), ids);
  const items = mapGithub({ data: { ...fixture.data, authored: { nodes: kept }, review: { nodes: [] } } }, filters);
  assert.deepEqual(items.find((it) => it.id === `github:${ids[1]}`).pr.checks, []);
});

test("a PR GitHub can't find or won't show drops out; the rest stay", () => {
  const ids = all.slice(0, 3).map((n) => n.id);
  for (const type of ["NOT_FOUND", "FORBIDDEN"]) {
    const nodes = ids.map(pr);
    nodes[1] = null;
    const kept = detailNodes(ids, { data: { nodes }, errors: [{ type, message: type, path: ["nodes", 1] }] });
    assert.deepEqual(kept.map((n) => n.id), [ids[0], ids[2]]);
  }
});

test("a PR lost to anything else fails the page, and a rate limit says so", () => {
  const ids = all.slice(0, 2).map((n) => n.id);
  const lost = [pr(ids[0]), null];
  assert.equal(kind(() => detailNodes(ids, { data: { nodes: lost }, errors: [{ type: "SERVICE_UNAVAILABLE", message: "timeout", path: ["nodes", 1] }] })), "other");
  assert.equal(kind(() => detailNodes(ids, { data: { nodes: lost }, errors: [{ message: "Something went wrong" }] })), "other");
  assert.equal(kind(() => detailNodes(ids, { data: { nodes: lost } })), "other");
  assert.equal(kind(() => detailNodes(ids, { data: { nodes: [pr(ids[0])] } })), "other");
  assert.equal(kind(() => detailNodes(ids, { data: null })), "other");
  assert.equal(kind(() => detailNodes(ids, { data: { nodes: ids.map(pr) }, errors: [{ type: "RATE_LIMITED", message: "slow down" }] })), "rateLimited");
});

test("sections follow the search: authored first, then review requests, each pull request once", () => {
  const listing = listingOf(fixture);
  const rows = sectioned(listing, filters);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.deepEqual(rows.map((r) => [`github:${r.id}`, r.section]), mapGithub(fixture, filters).map((it) => [it.id, it.section]));
  assert.deepEqual(sectioned(listing, { authored: false, reviewRequests: true }).map((r) => r.section).filter((s) => s === "authored"), []);
});
