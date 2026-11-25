import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { after, before, describe, it, mock as testMock } from "node:test";
import { CDP_CONNECT_TIMEOUT, CdpError, connectCdp, evaluate } from "../lib/cdp.mjs";
import { withSignal } from "../lib/util.mjs";
import { startMockCdp } from "./mock-cdp.mjs";

describe("CDP client", () => {
  let mock;
  before(async () => {
    mock = await startMockCdp({
      handlers: {
        "Echo.ping": (params) => ({ pong: params.value }),
        "Echo.fail": () => { throw new Error("boom"); },
        "Echo.never": () => mock.NO_REPLY,
        "Echo.later": (params, { peer }) => { setTimeout(() => peer.event("Echo.done", { value: params.value }), 20); return {}; },
        "Runtime.evaluate": (params) => params.expression === "throw" ? { exceptionDetails: { text: "Uncaught", exception: { description: "Error: thrown" } } } : { result: { type: "number", value: 42 } },
      },
    });
  });
  after(() => mock.close());

  it("matches replies to requests", async () => {
    const session = await connectCdp(mock.url());
    const [a, b] = await Promise.all([session.send("Echo.ping", { value: 1 }), session.send("Echo.ping", { value: 2 })]);
    assert.deepEqual([a.pong, b.pong], [1, 2]);
    await session.close();
  });

  it("turns protocol errors into CdpError", async () => {
    const session = await connectCdp(mock.url());
    await assert.rejects(session.send("Echo.fail"), (error) => error instanceof CdpError && /boom/.test(error.message) && error.method === "Echo.fail");
    await session.close();
  });

  it("times out a request that never answers", async () => {
    const session = await connectCdp(mock.url());
    await assert.rejects(session.send("Echo.never", {}, { timeout: 100 }), /timed out after 100 ms/);
    await session.close();
  });

  it("rejects a pending request and an event wait when the current signal aborts", async () => {
    const session = await connectCdp(mock.url());
    const controller = new AbortController();
    const reason = new Error("check stopped");
    const pending = withSignal(controller.signal, () => [session.send("Echo.never", {}, { timeout: 5000 }), session.waitFor("Echo.done", () => true, 5000)]);
    setTimeout(() => controller.abort(reason), 30);
    const started = Date.now();
    for (const request of pending) await assert.rejects(request, (error) => error === reason);
    assert.ok(Date.now() - started < 1000);
    await assert.rejects(withSignal(controller.signal, () => session.send("Echo.ping", { value: 1 })), (error) => error === reason);
    assert.deepEqual((await session.send("Echo.ping", { value: 3 })).pong, 3);
    await session.close();
  });

  it("waits for events with a predicate", async () => {
    const session = await connectCdp(mock.url());
    const waiting = session.waitFor("Echo.done", (p) => p.value === 7, 2000);
    await session.send("Echo.later", { value: 7 });
    assert.deepEqual(await waiting, { value: 7 });
    await assert.rejects(session.waitFor("Echo.done", () => true, 50), /Timed out after 50 ms/);
    await session.close();
  });

  it("rejects pending work when the peer closes", async () => {
    const session = await connectCdp(mock.url());
    const pending = session.send("Echo.never", {}, { timeout: 5000 });
    const waiting = session.waitFor("Never.happens", () => true, 5000);
    mock.peers.at(-1).close();
    await assert.rejects(pending, /closed/);
    await assert.rejects(waiting, /closed/);
    assert.equal(session.closed, true);
    await assert.rejects(session.send("Echo.ping"), /closed before Echo.ping/);
  });

  it("reports evaluation exceptions", async () => {
    const session = await connectCdp(mock.url());
    assert.equal(await evaluate(session, "41 + 1"), 42);
    await assert.rejects(evaluate(session, "throw"), /Error: thrown/);
    await session.close();
  });

  it("fails fast when nothing listens", async () => {
    await assert.rejects(connectCdp("ws://127.0.0.1:9/devtools/browser/x", { timeout: 2000 }), /failed|timed out/);
  });

  it("waits 15 s by default for the DevTools socket to open", async () => {
    assert.equal(CDP_CONNECT_TIMEOUT, 15000);
    class SilentSocket extends EventTarget {
      constructor(url) { super(); this.url = url; this.closedByClient = false; SilentSocket.last = this; }
      close() { this.closedByClient = true; }
      send() {}
    }
    testMock.timers.enable({ apis: ["setTimeout"] });
    try {
      let settled = null;
      const connecting = connectCdp("ws://127.0.0.1:1/devtools/browser/slow", { WebSocketImpl: SilentSocket }).then(() => { settled = "open"; }, (error) => { settled = error; });
      testMock.timers.tick(14999);
      await Promise.resolve();
      assert.equal(settled, null);
      assert.equal(SilentSocket.last.closedByClient, false);
      testMock.timers.tick(1);
      await connecting;
      assert.match(settled.message, /timed out after 15000 ms/);
      assert.equal(SilentSocket.last.closedByClient, true);
    } finally {
      testMock.timers.reset();
    }
  });

  it("closes the socket and rejects when the signal aborts during the handshake", async () => {
    let socket = null;
    class SilentSocket extends EventTarget {
      constructor() { super(); this.closedByClient = false; socket = this; }
      close() { this.closedByClient = true; }
      send() {}
    }
    const controller = new AbortController();
    const reason = new Error("check stopped");
    const connecting = connectCdp("ws://127.0.0.1:1/devtools/browser/slow", { WebSocketImpl: SilentSocket, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(connecting, (error) => error === reason);
    assert.equal(socket.closedByClient, true);
    await assert.rejects(connectCdp("ws://127.0.0.1:1/devtools/browser/slow", { WebSocketImpl: SilentSocket, signal: controller.signal }), (error) => error === reason);
  });

  it("still rejects promptly with an explicit short timeout when the upgrade never answers", async () => {
    const sockets = new Set();
    const server = http.createServer();
    server.on("upgrade", (request, socket) => { sockets.add(socket); socket.on("error", () => {}); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const started = Date.now();
      await assert.rejects(connectCdp(`ws://127.0.0.1:${server.address().port}/devtools/browser/stuck`, { timeout: 200 }), /timed out after 200 ms/);
      assert.ok(Date.now() - started < 2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });
});
