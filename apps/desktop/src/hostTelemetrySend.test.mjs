import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_INGEST_KEY } from "../../../packages/core/src/ingestKeys.ts";
import { linuxAdvertised, nativeHost } from "../scripts/linux-capabilities.mjs";
import { hostTelemetrySend, TELEMETRY_CANCEL_POST, TELEMETRY_POST } from "./hostTelemetrySend.ts";

const source = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const requestIdPolicy = source("engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_suggest_policy.h");
const nativeClient = source("engine/ardiacore-linux/src/ardia/linux/ac_linux_telemetry.cc");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async () => {
  for (let turn = 0; turn < 3; turn++) await tick();
};
async function until(reached, what) {
  for (const deadline = Date.now() + 5000; !reached();) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await tick();
  }
}

function fakeHost({ capabilities = [TELEMETRY_POST, TELEMETRY_CANCEL_POST], cancel = () => Promise.resolve(null) } = {}) {
  const calls = [];
  const replies = [];
  const reported = [];
  const host = {
    bootstrap: { windowId: "w1", profileId: "default", capabilities },
    invoke(method, args) {
      calls.push({ method, args: args.args });
      if (method === TELEMETRY_CANCEL_POST) return cancel();
      const reply = deferred();
      replies.push(reply);
      return reply.promise;
    },
    call: async () => "{}",
    onEvent: () => () => {},
  };
  return { host, calls, replies, reported, send: hostTelemetrySend(host, (error) => reported.push(error)) };
}

const methods = (calls) => calls.map((call) => call.method);
const bounded = { timeout: 10_000 };

test("the Linux host advertises and routes the cancel, and a request id fits the rule the native client checks", bounded, async () => {
  assert.ok(linuxAdvertised.includes(TELEMETRY_POST));
  assert.ok(linuxAdvertised.includes(TELEMETRY_CANCEL_POST));
  assert.ok(nativeHost.includes(`if (method == "${TELEMETRY_CANCEL_POST}") {`));
  assert.match(nativeClient, /bool RequestIdAcceptable\(std::string_view request_id\) \{\n {2}return ardia::desktop_suggest_policy::ValidRequestId\(request_id\);\n\}/);
  const [, limit, alphabet] = /inline bool ValidRequestId\(std::string_view id\) \{\n {2}if \(id\.empty\(\) \|\| id\.size\(\) > (\d+)\)[\s\S]*?if \(!\(([^{]*)\)\) \{/.exec(requestIdPolicy);
  assert.deepEqual([...alphabet.matchAll(/'(.)'/g)].map((match) => match[1]).join(""), "azAZ09-_");
  const { calls, send } = fakeHost();
  for (let post = 0; post < 3; post++) void send("{}");
  await until(() => calls.length === 3, "three posts");
  for (const call of calls) {
    assert.match(call.args[2], /^[a-zA-Z0-9_-]+$/);
    assert.ok(call.args[2].replace(/\d+$/, "").length + String(Number.MAX_SAFE_INTEGER).length <= Number(limit));
  }
});

test("a post carries the body, the app's ingest key and a request id, and answers the host's status", bounded, async () => {
  const { calls, replies, send } = fakeHost();
  const sent = send("{\"resourceLogs\":[]}", new AbortController().signal);
  await until(() => calls.length === 1, "the post");
  assert.deepEqual(methods(calls), [TELEMETRY_POST]);
  const [body, key, id] = calls[0].args;
  assert.equal(body, "{\"resourceLogs\":[]}");
  assert.equal(key, APP_INGEST_KEY);
  assert.match(id, /^telemetry-[0-9a-f-]{36}-\d+$/);
  replies[0].resolve({ status: 204 });
  assert.equal(await sent, 204);
  for (const [reply, status] of [[null, 0], [{}, 0], [{ status: "200" }, 0], [{ status: 200.5 }, 0], [{ status: 503 }, 503]]) {
    const next = send("{}");
    const posted = replies.length + 1;
    await until(() => replies.length === posted, "the next post");
    replies.at(-1).resolve(reply);
    assert.equal(await next, status);
  }
});

test("aborting an upload under way cancels that post in the host and answers 0 without waiting for it", bounded, async () => {
  const { calls, replies, reported, send } = fakeHost();
  const abort = new AbortController();
  const other = send("{}", new AbortController().signal);
  const sent = send("{}", abort.signal);
  await until(() => calls.length === 2, "both posts");
  abort.abort();
  assert.equal(await sent, 0);
  await until(() => calls.length === 3, "the cancel");
  assert.deepEqual(methods(calls), [TELEMETRY_POST, TELEMETRY_POST, TELEMETRY_CANCEL_POST]);
  assert.deepEqual(calls[2].args, [calls[1].args[2]]);
  assert.notEqual(calls[0].args[2], calls[1].args[2]);
  replies[1].resolve({ status: 200 });
  replies[0].resolve({ status: 200 });
  assert.equal(await other, 200);
  abort.abort();
  await idle();
  assert.equal(calls.length, 3);
  assert.deepEqual(reported, []);
});

test("an upload aborted before its post leaves the renderer never reaches the host", bounded, async () => {
  const before = fakeHost();
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await before.send("{}", aborted.signal), 0);
  const sameTick = fakeHost();
  const abort = new AbortController();
  const sent = sameTick.send("{}", abort.signal);
  abort.abort();
  assert.equal(await sent, 0);
  await idle();
  assert.deepEqual([before.calls, sameTick.calls], [[], []]);
});

test("an abort after the host answered cancels nothing", bounded, async () => {
  const { calls, replies, send } = fakeHost();
  const abort = new AbortController();
  const sent = send("{}", abort.signal);
  await until(() => replies.length === 1, "the post");
  replies[0].resolve({ status: 200 });
  assert.equal(await sent, 200);
  abort.abort();
  await idle();
  assert.deepEqual(methods(calls), [TELEMETRY_POST]);
});

test("a reloaded shell renderer never reuses a request id the window's native client may still hold", bounded, async () => {
  const reloaded = await import(`./hostTelemetrySend.ts?renderer=${Date.now()}`);
  const { host, calls, send } = fakeHost();
  void send("{}");
  void reloaded.hostTelemetrySend(host, () => {})("{}");
  await until(() => calls.length === 2, "both renderers' posts");
  const [first, second] = calls.map((call) => call.args[2]);
  assert.match(second, /^telemetry-[0-9a-f-]{36}-1$/);
  assert.notEqual(first.replace(/-\d+$/, ""), second.replace(/-\d+$/, ""));
});

test("a host without the cancel route gets the two-argument post and never draws a UUID, and an abort still answers at once", bounded, async (t) => {
  const drawn = t.mock.method(globalThis.crypto, "randomUUID");
  const fresh = await import(`./hostTelemetrySend.ts?uncancellable=${Date.now()}`);
  const { host, calls, replies } = fakeHost({ capabilities: [TELEMETRY_POST] });
  const send = fresh.hostTelemetrySend(host, () => {});
  const abort = new AbortController();
  const sent = send("{}", abort.signal);
  await until(() => calls.length === 1, "the post");
  assert.deepEqual(calls[0].args, ["{}", APP_INGEST_KEY]);
  abort.abort();
  assert.equal(await sent, 0);
  replies[0].resolve({ status: 200 });
  await idle();
  assert.deepEqual(methods(calls), [TELEMETRY_POST]);
  assert.equal(drawn.mock.callCount(), 0);
});

test("a host error rejects a live send, is dropped after an abort, and a refused cancel is reported", bounded, async () => {
  const refused = Object.assign(new Error("refused"), { code: "ERR_TELEMETRY_REFUSED" });
  const { replies, reported, send } = fakeHost({ cancel: () => Promise.reject(refused) });
  const abort = new AbortController();
  const sent = send("{}", abort.signal);
  await until(() => replies.length === 1, "the post");
  abort.abort();
  replies[0].reject(new Error("gone"));
  assert.equal(await sent, 0);
  await until(() => reported.length === 1, "the refused cancel");
  assert.deepEqual(reported, [refused]);
  const failing = send("{}", new AbortController().signal);
  await until(() => replies.length === 2, "the second post");
  replies[1].reject(refused);
  await assert.rejects(failing, { code: "ERR_TELEMETRY_REFUSED" });
});

test("turning sharing off, or resetting the anonymous ID, cancels the upload under way in the host and counts nothing for it", bounded, async (t) => {
  globalThis.__DEV__ = false;
  await import("../../browser/src/test-native/index.ts");
  const transport = await import("../../browser/src/state/telemetry/transport.ts");
  const client = await import("../../browser/src/state/telemetry/client.ts");
  t.after(() => client.setSharing(false, "settings"));
  const { calls, replies, reported, send } = fakeHost();
  transport.setTelemetryHost({ os: "Linux", osType: "linux", send });
  client.loadChoice();
  const posts = () => calls.filter((call) => call.method === TELEMETRY_POST);
  const cancels = () => calls.filter((call) => call.method === TELEMETRY_CANCEL_POST).map((call) => call.args);
  const uploading = async () => {
    client.setSharing(true, "settings");
    transport.takePostStats();
    const before = posts().length;
    const flushed = client.flush();
    await until(() => posts().length === before + 1, "the upload");
    return { flushed };
  };

  const turnedOff = await uploading();
  client.setSharing(false, "settings");
  await turnedOff.flushed;
  await until(() => cancels().length === 1, "the cancel for sharing turned off");
  assert.deepEqual(cancels(), [[posts()[0].args[2]]]);
  assert.deepEqual(transport.takePostStats(), { bytes: 0, failed: 0, requests: 0 });

  const reset = await uploading();
  client.replaceInstallId();
  await reset.flushed;
  await until(() => cancels().length === 2, "the cancel for the reset");
  assert.deepEqual(cancels(), posts().map((post) => [post.args[2]]));

  for (const reply of replies) reply.resolve({ status: 200 });
  await idle();
  assert.deepEqual(transport.takePostStats(), { bytes: 0, failed: 0, requests: 0 });
  assert.deepEqual(reported, []);
});
