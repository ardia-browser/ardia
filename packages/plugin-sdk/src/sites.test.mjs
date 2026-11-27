import assert from "node:assert/strict";
import { test } from "node:test";

const { sitesApi, deliverSiteDownload } = await import("./sites.ts");
const { createRegistry } = await import("./types.ts");

function fakeRpc(answers) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : answer;
    },
  };
}

test("done settles from the terminal event even when onProgress throws, and the throw is reported", async () => {
  const registry = createRegistry();
  const reported = [];
  const rpc = fakeRpc({ "sites.download": { download: "d1" } });
  const sites = sitesApi(rpc, registry, (e) => reported.push(e));
  const dl = await sites.download("https://a.example/x", {
    to: "x",
    onProgress: () => {
      throw new Error("boom");
    },
  });
  deliverSiteDownload(registry, { download: "d1", state: "running", received: 5 }, () => {});
  deliverSiteDownload(registry, { download: "d1", state: "done", received: 10, size: 10 }, () => {});
  assert.deepEqual(await dl.done, { size: 10 });
  assert.equal(reported.length, 2);
  assert.equal(registry.sites.listeners.size, 0, "the listener is gone");
});

test("a lost terminal event is found by asking sites.status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = createRegistry();
  const rpc = fakeRpc({ "sites.download": { download: "d2" }, "sites.status": { download: "d2", state: "failed", received: 3, code: "too_large", error: "over" } });
  const dl = await sitesApi(rpc, registry).download("https://a.example/x", { to: "x" });
  t.mock.timers.tick(5000);
  await assert.rejects(dl.done, (e) => e.code === "too_large");
  assert.ok(rpc.calls.some((c) => c.method === "sites.status" && c.params.download === "d2"));
});

test("fetch and session send the channel's params", async () => {
  const rpc = fakeRpc({ "sites.fetch": { status: 200, ok: true, headers: {}, body: '{"a":1}' }, "sites.session": { session: "s1" }, "sites.available": { available: false } });
  const sites = sitesApi(rpc, createRegistry());
  assert.equal(await sites.available(), false);
  assert.equal(await sites.session(), "s1");
  const res = await sites.fetch("https://a.example/x", { method: "POST", body: "{}", session: "s1" });
  assert.deepEqual(res.json(), { a: 1 });
  assert.deepEqual(rpc.calls.at(-1), { method: "sites.fetch", params: { url: "https://a.example/x", method: "POST", body: "{}", session: "s1" } });
});
