import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_STRINGS, HOSTILE_VALUES, PROTOTYPE_KEYS } from "../../../../../scripts/security/hostile-inputs.mjs";
const { S, socketClient, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { DEVTOOLS_ENDPOINT } = await import("./socketDevtools.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
setConsentPeriod(true, "socket-devtools-test");

const TOKEN = "CanaryDevtoolsSocket_9z8y7x6w5v4u3t2s1r0q";
const GIVEN = { port: 41234, generation: 3, token: TOKEN };

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const everything = () => [...stub.controlSocket.replies.map((r) => r.line), ...stub.controlSocket.broadcasts.map((b) => b.line), JSON.stringify(takeCliCounts())].join("\n");

const logged = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const original = console[level];
  console[level] = (...args) => (logged.push(args.map(String).join(" ")), original.apply(console, args));
}

after(() => {
  stub.controlSocket.devtoolsEndpoint = () => ({ problem: "off" });
  S().updateSettings({ cliControl: false });
});

async function fresh() {
  S().hydrate({});
  await controlOn();
  takeCliCounts();
  stub.controlSocket.devtoolsEndpointAsks.length = 0;
  stub.controlSocket.replies.length = 0;
  stub.controlSocket.broadcasts.length = 0;
}

test("methods lists control.devtoolsEndpoint as a read that takes nothing", async () => {
  await fresh();
  const list = await socketClient(401).ok("methods");
  const entry = list.find((m) => m.name === DEVTOOLS_ENDPOINT);
  assert.ok(entry);
  assert.equal(entry.mutates, false);
  assert.equal(entry.area, "control");
  assert.equal(entry.result, "{port, token, generation}");
  const extra = await socketClient(401).call(DEVTOOLS_ENDPOINT, { profile: "x" });
  assert.equal(extra.error?.code, "bad_request");
});

test("a peer the socket admitted gets the port, token and generation, and the count says given", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = () => GIVEN;
  const before = stub.controlSocket.replies.length;
  const reply = await socketClient(402).call(DEVTOOLS_ENDPOINT);
  assert.deepEqual(reply, { id: 1, result: GIVEN });
  assert.deepEqual(Object.keys(reply.result), ["port", "token", "generation"]);
  assert.deepEqual(stub.controlSocket.devtoolsEndpointAsks, [402], "native is asked about this connection, so it can check the peer is still admitted");
  const lines = stub.controlSocket.replies.slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].connection, 402, "the token goes only to the connection that asked");
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_devtools_endpoint_given, 1);
  assert.equal(counts.cli_socket_calls_core, 1);
  assert.equal(counts.cli_socket_call_failures, 0);
});

test("a peer native no longer admits (refused, approval run out or revoked, gone) never gets the token", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = (connection) => (connection === 403 ? { problem: "left" } : GIVEN);
  const reply = await socketClient(403).call(DEVTOOLS_ENDPOINT);
  assert.equal(reply.error?.code, "failed");
  assert.ok(!JSON.stringify(reply).includes(TOKEN));
  assert.equal(takeCliCounts().cli_socket_devtools_endpoint_left, 1);
});

test("with control off the call is refused before native is asked", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = () => GIVEN;
  S().updateSettings({ cliControl: false });
  await settle();
  const reply = await socketClient(404).call(DEVTOOLS_ENDPOINT);
  assert.deepEqual(reply.error, { code: "failed", message: "Control is off." });
  assert.deepEqual(stub.controlSocket.devtoolsEndpointAsks, []);
  assert.equal(takeCliCounts().cli_socket_devtools_endpoint_control_off, 1);
  await controlOn();
});

test("control turned off while native reads the token: nothing is sent", async () => {
  await fresh();
  let release;
  stub.controlSocket.devtoolsEndpoint = () => new Promise((resolve) => (release = () => resolve(GIVEN)));
  const client = socketClient(405);
  const pending = client.call(DEVTOOLS_ENDPOINT);
  await settle();
  assert.deepEqual(stub.controlSocket.devtoolsEndpointAsks, [405]);
  S().updateSettings({ cliControl: false });
  await settle();
  release();
  const reply = await pending;
  assert.deepEqual(reply.error, { code: "failed", message: "Control is off." });
  assert.ok(!everything().includes(TOKEN));
  await controlOn();
});

test("a server that isn't on, an unreadable token, and a host without the call each fail with their own outcome", async () => {
  await fresh();
  const cases = [
    [{ problem: "off" }, "server_off", "failed"],
    [{ problem: "unreadable" }, "unreadable", "failed"],
    [{ problem: "something new" }, "unreadable", "failed"],
    [{ port: 1, generation: 1 }, "unreadable", "failed"],
    [{ port: "1", generation: 1, token: TOKEN }, "unreadable", "failed"],
  ];
  for (const [answer, outcome, code] of cases) {
    stub.controlSocket.devtoolsEndpoint = () => answer;
    const reply = await socketClient(406).call(DEVTOOLS_ENDPOINT);
    assert.equal(reply.error?.code, code, JSON.stringify(answer));
    assert.equal(takeCliCounts()[`cli_socket_devtools_endpoint_${outcome}`], 1, JSON.stringify(answer));
    assert.ok(!JSON.stringify(reply).includes(TOKEN));
  }
  stub.controlSocket.devtoolsEndpoint = null;
  const missing = await socketClient(406).call(DEVTOOLS_ENDPOINT);
  assert.equal(missing.error?.code, "unknown_method", "a Mac whose native module lacks the call answers as an older Ardia does");
  assert.equal(takeCliCounts().cli_socket_devtools_endpoint_unsupported, 1);
});

test("where the socket has no doorbell (Linux, Windows) the method isn't listed, answers unknown_method and never asks native", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = () => GIVEN;
  PLATFORM_FEATURES.controlDoorbell = false;
  try {
    const list = await socketClient(409).ok("methods");
    assert.ok(!list.some((m) => m.name === DEVTOOLS_ENDPOINT));
    const reply = await socketClient(409).call(DEVTOOLS_ENDPOINT);
    assert.equal(reply.error?.code, "unknown_method");
    assert.match(reply.error.message, /ArdiaControl\.json/);
    assert.deepEqual(stub.controlSocket.devtoolsEndpointAsks, []);
    assert.equal(takeCliCounts().cli_socket_devtools_endpoint_unsupported, 1);
  } finally {
    PLATFORM_FEATURES.controlDoorbell = true;
  }
});

test("a peer that stops writing while native reads is abandoned as gone, not told control is off", async () => {
  await fresh();
  let release;
  stub.controlSocket.devtoolsEndpoint = () => new Promise((resolve) => (release = () => resolve(GIVEN)));
  const pending = socketClient(410).call(DEVTOOLS_ENDPOINT);
  await settle();
  stub.emitControlClose(410);
  release();
  const reply = await pending;
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /closed before the token was ready/);
  assert.ok(!everything().includes(TOKEN));
});

test("the token never reaches telemetry counts, logs or another connection's lines", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = () => GIVEN;
  const watcher = socketClient(407);
  await watcher.ok("subscribe", { events: ["*"] });
  stub.controlSocket.replies.length = 0;
  stub.controlSocket.broadcasts.length = 0;
  logged.length = 0;
  await socketClient(408).ok(DEVTOOLS_ENDPOINT);
  await settle();
  const elsewhere = stub.controlSocket.replies.filter((r) => r.connection !== 408).map((r) => r.line);
  assert.deepEqual(elsewhere.filter((line) => line.includes(TOKEN)), []);
  assert.ok(!stub.controlSocket.broadcasts.some((b) => b.line.includes(TOKEN)));
  assert.ok(!JSON.stringify(takeCliCounts()).includes(TOKEN));
  assert.ok(!logged.some((line) => line.includes(TOKEN)));
});

test("turning control off cuts native off at once, before anything else of the stop, so a queued token line can't start", async () => {
  await fresh();
  stub.controlSocket.calls.length = 0;
  S().updateSettings({ cliControl: false });
  assert.deepEqual(stub.controlSocket.calls, ["cutOff"], "native is cut off synchronously, in the same turn as the setting change");
  await settle();
  assert.deepEqual(stub.controlSocket.calls, ["cutOff", "stop"]);
  await controlOn();
});

test("every shared hostile input, as params, as a param name or as a request id, is refused before native is asked, and the token reaches only a well-formed request's own reply", async () => {
  await fresh();
  stub.controlSocket.devtoolsEndpoint = () => GIVEN;
  const client = socketClient(411);
  const control = await client.call(DEVTOOLS_ENDPOINT, {});
  assert.deepEqual(control.result, GIVEN, "positive control: a well-formed request gets the token through the same path");
  const sinkSeen = () => stub.controlSocket.devtoolsEndpointAsks.length;
  const noParams = new Set([undefined, "{}"]);
  let refused = 0;
  const send = async (label, line, wellFormed) => {
    const asked = sinkSeen();
    stub.controlSocket.replies.length = 0;
    const reply = await client.fire(label, null, line);
    const carriesToken = JSON.stringify(reply).includes(TOKEN);
    if (wellFormed) {
      assert.deepEqual(reply.result, GIVEN, `${label}: a request with no params still gets the token`);
      return;
    }
    refused++;
    assert.ok(reply.error, `${label}: refused`);
    assert.equal(sinkSeen(), asked, `${label}: native was never asked`);
    assert.ok(!carriesToken, `${label}: no token in the reply`);
  };
  for (const { id, value } of HOSTILE_VALUES) {
    const wire = JSON.stringify(value);
    await send(`params ${id}`, `{"id":1,"method":"${DEVTOOLS_ENDPOINT}"${wire === undefined ? "" : `,"params":${wire}`}}`, noParams.has(wire));
  }
  for (const { id, value } of HOSTILE_STRINGS) {
    await send(`param name ${id}`, JSON.stringify({ id: 1, method: DEVTOOLS_ENDPOINT, params: { [value]: true } }), false);
  }
  for (const key of PROTOTYPE_KEYS) {
    await send(`own key ${key}`, `{"id":1,"method":"${DEVTOOLS_ENDPOINT}","params":{${JSON.stringify(key)}:{"ardiaPolluted":true}}}`, false);
  }
  assert.equal({}.ardiaPolluted, undefined);
  for (const { id, value } of HOSTILE_VALUES) {
    const wire = JSON.stringify(value);
    if (wire === undefined) continue;
    stub.controlSocket.replies.length = 0;
    const asked = sinkSeen();
    stub.emitControlRequest({ connection: 411, generation: stub.controlSocket.generation, line: `{"id":${wire},"method":"${DEVTOOLS_ENDPOINT}"}` });
    await settle();
    const lines = stub.controlSocket.replies.map((r) => r.line);
    assert.equal(lines.length, 1, `id ${id}: one reply`);
    const reply = JSON.parse(lines[0]);
    if (reply.result) {
      assert.deepEqual(reply.result, GIVEN, `id ${id}`);
      assert.deepEqual(reply.id, JSON.parse(wire), `id ${id}: the token goes back under the id that asked`);
    } else {
      assert.equal(reply.id, null, `id ${id}: a refused id isn't echoed`);
      assert.equal(sinkSeen(), asked, `id ${id}: native was never asked`);
      assert.ok(!lines[0].includes(TOKEN), `id ${id}`);
    }
  }
  assert.ok(refused > HOSTILE_VALUES.length, "the corpus ran");
  assert.ok(stub.controlSocket.replies.every((r) => r.connection === 411));
});
