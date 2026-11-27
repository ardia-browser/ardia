import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc, MAX_IN_FLIGHT, MAX_IN_FLIGHT_BYTES, readReplyBytes } from "./rpc.ts";

test("rpc keeps at most MAX_IN_FLIGHT requests unanswered and sends the rest as replies come back", async () => {
  const sent = [];
  let unanswered = 0;
  let peak = 0;
  const rpc = createRpc({
    send: (line) => {
      sent.push(JSON.parse(line));
      unanswered++;
      peak = Math.max(peak, unanswered);
    },
    onLine: () => {},
  });
  const calls = Array.from({ length: 200 }, (_, i) => rpc.request("files.read", { i }));
  assert.equal(sent.length, MAX_IN_FLIGHT);
  assert.equal(rpc.pendingCount(), 200);
  let answered = 0;
  while (answered < sent.length) {
    const msg = sent[answered++];
    unanswered--;
    rpc.takeReply({ id: msg.id, result: msg.params.i });
    assert.ok(unanswered <= MAX_IN_FLIGHT);
  }
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 200 }, (_, i) => i));
  assert.equal(sent.length, 200);
  assert.equal(peak, MAX_IN_FLIGHT);
  assert.ok(MAX_IN_FLIGHT < 32);
  assert.equal(rpc.pendingCount(), 0);
});

test("closing the rpc rejects queued requests that were never sent", async () => {
  const sent = [];
  const rpc = createRpc({ send: (line) => sent.push(line), onLine: () => {} });
  const calls = Array.from({ length: MAX_IN_FLIGHT + 5 }, () => rpc.request("x"));
  rpc.close(new Error("gone"));
  const results = await Promise.allSettled(calls);
  assert.equal(sent.length, MAX_IN_FLIGHT);
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.message === "gone"));
});

test("rpc keeps the bytes of unanswered requests and their expected replies under its budget, and always sends one", async () => {
  const sent = [];
  const rpc = createRpc({ send: (line) => sent.push(JSON.parse(line)), onLine: () => {} });
  const chunk = 4 << 20;
  const reads = Array.from({ length: 14 }, (_, i) => rpc.request("files.read", { i, length: chunk }, { replyBytes: readReplyBytes(chunk) }));
  const perRead = readReplyBytes(chunk);
  assert.ok(perRead > chunk * 1.33, "a read's reply is counted as its base64");
  assert.equal(sent.length, Math.floor(MAX_IN_FLIGHT_BYTES / perRead), "only as many 4 MiB reads as the budget holds go out at once");
  assert.ok(rpc.inFlightBytes() <= MAX_IN_FLIGHT_BYTES);
  let answered = 0;
  while (answered < sent.length) {
    const msg = sent[answered++];
    rpc.takeReply({ id: msg.id, result: msg.params.i });
    assert.ok(rpc.inFlightBytes() <= MAX_IN_FLIGHT_BYTES);
  }
  assert.deepEqual(await Promise.all(reads), Array.from({ length: 14 }, (_, i) => i));
  assert.equal(rpc.inFlightBytes(), 0);
  const huge = rpc.request("files.write", { data: "x".repeat(MAX_IN_FLIGHT_BYTES + 10) });
  const small = rpc.request("ping");
  assert.equal(sent.length, 15, "a request over the whole budget still goes out when nothing else is in flight, and what follows waits for it");
  rpc.takeReply({ id: sent[14].id, result: "big" });
  assert.equal(sent.length, 16);
  rpc.takeReply({ id: sent[15].id, result: "pong" });
  assert.deepEqual(await Promise.all([huge, small]), ["big", "pong"]);
});

test("a request whose send throws gives its budget back", async () => {
  let refuse = true;
  const sent = [];
  const rpc = createRpc({
    send: (line) => {
      if (refuse) throw new Error("Ardia isn't reading, so the line was dropped");
      sent.push(JSON.parse(line));
    },
    onLine: () => {},
  });
  await assert.rejects(rpc.request("files.read", {}, { replyBytes: 8 << 20 }), /isn't reading/);
  assert.equal(rpc.inFlightBytes(), 0);
  refuse = false;
  const next = rpc.request("x");
  assert.equal(sent.length, 1);
  rpc.takeReply({ id: sent[0].id, result: 1 });
  assert.equal(await next, 1);
});

test("codex S4: a protocol reply goes out at once while bulk reads hold every slot and byte of their own", async () => {
  const sent = [];
  const rpc = createRpc({ send: (line) => sent.push(JSON.parse(line)), onLine: () => {} });
  const chunk = 4 << 20;
  const reads = Array.from({ length: 40 }, (_, i) => rpc.request("files.read", { i, length: chunk }, { replyBytes: readReplyBytes(chunk) }));
  const readsSent = sent.length;
  assert.ok(readsSent < 40, "bulk reads are paced");
  const reply = rpc.request("result", { call: "c1", result: 1 }, { protocol: true });
  assert.equal(sent.length, readsSent + 1, "the result isn't queued behind the reads");
  assert.equal(sent.at(-1).method, "result");
  rpc.takeReply({ id: sent.at(-1).id, result: { ok: true } });
  assert.deepEqual(await reply, { ok: true });
  rpc.close(new Error("done"));
  await Promise.allSettled(reads);
});

test("codex S4: a queued protocol reply whose call was cancelled is dropped, never sent", async () => {
  const sent = [];
  const rpc = createRpc({ send: (line) => sent.push(JSON.parse(line)), onLine: () => {} });
  const held = Array.from({ length: 8 }, (_, i) => rpc.request("result", { call: `h${i}` }, { protocol: true }));
  assert.equal(sent.length, 8);
  let cancelled = false;
  const late = rpc.request("result", { call: "late" }, { protocol: true, dropIf: () => cancelled });
  assert.equal(sent.length, 8, "the ninth waits for a slot");
  cancelled = true;
  rpc.takeReply({ id: sent[0].id, result: null });
  assert.equal(await late, undefined);
  assert.ok(!sent.some((m) => m.params.call === "late"));
  rpc.close(new Error("done"));
  await Promise.allSettled(held);
});
