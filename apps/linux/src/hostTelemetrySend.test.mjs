import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_INGEST_KEY } from "../../../packages/core/src/ingestKeys.ts";
import { hostTelemetrySend, TELEMETRY_CANCEL_POST, TELEMETRY_POST } from "./hostTelemetrySend.ts";

const nativeHost = readFileSync(new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_host.cc", import.meta.url), "utf8");
const nativePolicy = readFileSync(new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_telemetry_policy.h", import.meta.url), "utf8");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeHost({ capabilities = [TELEMETRY_POST, TELEMETRY_CANCEL_POST] } = {}) {
  const calls = [];
  const replies = [];
  const host = {
    bootstrap: { windowId: "w1", profileId: "default", capabilities },
    invoke(method, args) {
      calls.push({ method, args: args.args });
      if (method === TELEMETRY_CANCEL_POST) return Promise.resolve(null);
      const reply = deferred();
      replies.push(reply);
      return reply.promise;
    },
    call: async () => "{}",
    onEvent: () => () => {},
  };
  return { host, calls, replies };
}

test("the host advertises the cancel route and the request ids fit the native policy", () => {
  assert.match(nativeHost, /\.Append\("ArdiaTelemetry\.post"\)\.Append\("ArdiaTelemetry\.cancelPost"\)/);
  assert.match(nativeHost, /if \(method == "ArdiaTelemetry\.cancelPost"\) \{/);
  assert.equal(Number(/kMaxRequestIdLength = (\d+);/.exec(nativePolicy)[1]), 64);
});

test("a post carries a request id and answers the host's status", async () => {
  const { host, calls, replies } = fakeHost();
  const sent = hostTelemetrySend(host)("{\"resourceLogs\":[]}", new AbortController().signal);
  await settle();
  assert.equal(calls.length, 1);
  const [body, key, id] = calls[0].args;
  assert.equal(calls[0].method, TELEMETRY_POST);
  assert.equal(body, "{\"resourceLogs\":[]}");
  assert.equal(key, APP_INGEST_KEY);
  assert.match(id, /^telemetry-[0-9a-f-]{36}-\d+$/);
  assert.ok(id.length <= 64);
  replies[0].resolve({ status: 204 });
  assert.equal(await sent, 204);
});

test("aborting an upload under way cancels it in the host and answers at once", async () => {
  const { host, calls } = fakeHost();
  const abort = new AbortController();
  const sent = hostTelemetrySend(host)("{}", abort.signal);
  await settle();
  abort.abort();
  assert.equal(await sent, 0);
  await settle();
  assert.deepEqual(calls.map((c) => c.method), [TELEMETRY_POST, TELEMETRY_CANCEL_POST]);
  assert.deepEqual(calls[1].args, [calls[0].args[2]]);
});

test("an abort right after the send still reaches the host after the post", async () => {
  const { host, calls } = fakeHost();
  const abort = new AbortController();
  const sent = hostTelemetrySend(host)("{}", abort.signal);
  abort.abort();
  assert.equal(await sent, 0);
  await settle();
  assert.deepEqual(calls.map((c) => c.method), [TELEMETRY_POST, TELEMETRY_CANCEL_POST]);
});

test("an upload aborted before it starts never reaches the host", async () => {
  const { host, calls } = fakeHost();
  const abort = new AbortController();
  abort.abort();
  assert.equal(await hostTelemetrySend(host)("{}", abort.signal), 0);
  await settle();
  assert.deepEqual(calls, []);
});

test("a reloaded shell renderer never reuses a request id the native client may still hold", async () => {
  const reloaded = await import(`./hostTelemetrySend.ts?renderer=${Date.now()}`);
  const { host, calls } = fakeHost();
  void hostTelemetrySend(host)("{}");
  void reloaded.hostTelemetrySend(host)("{}");
  await settle();
  const [first, second] = calls.map((c) => c.args[2]);
  assert.match(second, /^telemetry-[0-9a-f-]{36}-1$/);
  assert.notEqual(first.replace(/-\d+$/, ""), second.replace(/-\d+$/, ""));
});

test("each post gets its own request id", async () => {
  const { host, calls } = fakeHost();
  const send = hostTelemetrySend(host);
  void send("{}");
  void send("{}");
  await settle();
  assert.notEqual(calls[0].args[2], calls[1].args[2]);
});

test("an engine without the cancel route gets the two-argument post and the abort still answers at once", async () => {
  const { host, calls, replies } = fakeHost({ capabilities: [TELEMETRY_POST] });
  const abort = new AbortController();
  const sent = hostTelemetrySend(host)("{}", abort.signal);
  await settle();
  assert.deepEqual(calls[0].args, ["{}", APP_INGEST_KEY]);
  abort.abort();
  assert.equal(await sent, 0);
  replies[0].resolve({ status: 200 });
  await settle();
  assert.deepEqual(calls.map((c) => c.method), [TELEMETRY_POST]);
});

test("a host error after an abort is not an unhandled rejection, and one before it rejects the send", async () => {
  const { host, replies } = fakeHost();
  const abort = new AbortController();
  const sent = hostTelemetrySend(host)("{}", abort.signal);
  await settle();
  abort.abort();
  replies[0].reject(new Error("gone"));
  assert.equal(await sent, 0);
  const failing = hostTelemetrySend(host)("{}", new AbortController().signal);
  await settle();
  replies[1].reject(Object.assign(new Error("refused"), { code: "ERR_TELEMETRY_REFUSED" }));
  await assert.rejects(failing, { code: "ERR_TELEMETRY_REFUSED" });
});

test("turning sharing off cancels the Linux upload under way in the host and counts it as cancelled", async () => {
  globalThis.__DEV__ = false;
  const stub = await import("../../browser/src/test-native/index.ts");
  Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "6.12", arch: "x64", isolatedInstance: false });
  stub.docs.set("telemetry.json", JSON.stringify({ version: 99, sharing: true, installId: "linux-install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", sessionOpen: true }));
  const transport = await import("../../browser/src/state/telemetry/transport.ts");
  const client = await import("../../browser/src/state/telemetry/client.ts");
  const { host, calls, replies } = fakeHost();
  transport.setTelemetryHost({ os: "Linux", osType: "linux", send: hostTelemetrySend(host) });
  client.loadChoice();
  transport.takePostStats();
  client.capture("probe");
  const flushed = client.flush();
  await settle();
  const posts = calls.filter((c) => c.method === TELEMETRY_POST);
  assert.equal(posts.length, 1);
  client.setSharing(false, "settings");
  await flushed;
  await settle();
  const cancels = calls.filter((c) => c.method === TELEMETRY_CANCEL_POST);
  assert.deepEqual(cancels.map((c) => c.args), [[posts[0].args[2]]]);
  replies[0].resolve({ status: 200 });
  await settle();
  assert.deepEqual(transport.takePostStats(), { bytes: 0, cancelled: 1, failed: 0, requests: 1 });
});
