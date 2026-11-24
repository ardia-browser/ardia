import assert from "node:assert/strict";
import test from "node:test";
import { hostSwitchesFetch, untilAborted } from "./hostKillSwitches.ts";

test("the kill-switch file comes through the native host and every other fetch is left alone", async () => {
  const calls = [];
  const host = { bootstrap: { capabilities: ["ArdiaShell.fetchKillSwitches"] }, invoke: async (method) => (calls.push(method), { status: 200, body: "{\"version\":1,\"switches\":{}}" }) };
  const original = async (input) => new Response(`original ${input}`);
  const fetchFn = hostSwitchesFetch(host, original);
  assert.equal(await (await fetchFn("https://ardia.dev/switches.json")).text(), "{\"version\":1,\"switches\":{}}");
  assert.equal(await (await fetchFn("https://example.com/")).text(), "original https://example.com/");
  assert.deepEqual(calls, ["ArdiaShell.fetchKillSwitches"]);
  const refused = hostSwitchesFetch({ ...host, invoke: async () => ({ status: 0, body: "" }) }, original);
  await assert.rejects(refused("https://ardia.dev/switches.json"), TypeError);
});

test("the switch refresh through the native host updates the cached switches", async () => {
  globalThis.__DEV__ = false;
  await import("../../browser/src/test-native/index.ts");
  const { refreshSwitches, resetRefreshForTests } = await import("../../browser/src/platform/killSwitches.ts");
  resetRefreshForTests();
  const host = { bootstrap: { capabilities: [] }, invoke: async () => ({ status: 200, body: JSON.stringify({ version: 1, switches: { newTabPrewarm: false } }) }) };
  assert.equal(await refreshSwitches(hostSwitchesFetch(host, async () => { throw new Error("the shell can't fetch"); })), "updated");
});

test("an abort while the native host fetches rejects at once and ignores the late reply", async () => {
  let reply;
  const host = { bootstrap: { capabilities: ["ArdiaShell.fetchKillSwitches"] }, invoke: () => new Promise((resolve) => (reply = resolve)) };
  const fetchFn = hostSwitchesFetch(host, async () => new Response("original"));
  const controller = new AbortController();
  const pending = fetchFn("https://ardia.dev/switches.json", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof DOMException && error.name === "AbortError");
  reply({ status: 200, body: "{\"version\":1,\"switches\":{}}" });
  const before = new AbortController();
  before.abort();
  await assert.rejects(fetchFn("https://ardia.dev/switches.json", { signal: before.signal }), { name: "AbortError" });
});

test("the abort listener is removed once the native reply settles, either way", async () => {
  const listeners = new Set();
  const signal = { aborted: false, addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) };
  assert.equal(await untilAborted(Promise.resolve("ok"), signal), "ok");
  assert.equal(listeners.size, 0);
  await assert.rejects(untilAborted(Promise.reject(new Error("refused")), signal), /refused/);
  assert.equal(listeners.size, 0);
  assert.equal(await untilAborted(Promise.resolve("no signal"), undefined), "no signal");
});
