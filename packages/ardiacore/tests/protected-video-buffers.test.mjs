import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pageScript = read("../ios/page_script.js");
const native = read("../ios/ArdiaPVSession.mm");
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start}`);
  return text.slice(from, to);
};

const bufferMaker = () => {
  const deps = ["setPrototypeOf", "defineProperty", "SourceBuffer", "makeRoom", "sendMedia", "fire", "soon", "fireOwn", "mp4", "bridgeOf", "take", "progress", "timeRanges", "bytesOf", "dropRange", "UNDECODABLE", "MAX_PENDING_BYTES"];
  const source = between(pageScript, "      const makeBuffer = (b, mime) => {", "      const SourceProto = SourceType.prototype;");
  const make = new Function(...deps, `${source}\nreturn makeBuffer;`);
  const queue = [];
  const taken = [];
  const sent = [];
  const b = { el: {}, states: [], buffers: [], bufferSeq: 0, sourceEnded: false };
  const makeBuffer = make(
    Object.setPrototypeOf,
    Object.defineProperty,
    class SourceBuffer extends EventTarget {},
    () => true,
    (bridge, data) => sent.push(data),
    () => {},
    (fn) => queue.push(fn),
    (target, type) => target.dispatchEvent(new Event(type)),
    { split: (bytes) => ({ units: [bytes], rest: bytes.length }), merged: () => [] },
    new Map([[b.el, b]]),
    (bridge, st, unit) => taken.push([st.id, [...unit]]),
    () => {},
    () => ({}),
    (data) => new Uint8Array(data),
    () => {},
    /^$/,
    64e6,
  );
  const run = () => {
    while (queue.length) queue.shift()();
  };
  return { b, makeBuffer, run, taken, sent };
};

test("an append cancelled by abort() sends nothing, and the append after it sends its own bytes", () => {
  const { b, makeBuffer, run, taken } = bufferMaker();
  const { sb } = makeBuffer(b, "video/mp4");
  sb.appendBuffer([1, 1, 1]);
  sb.abort();
  sb.appendBuffer([2, 2]);
  run();
  assert.deepEqual(taken, [[1, [2, 2]]]);
  assert.equal(sb.updating, false);
});

test("a remove() cancelled by abort() doesn't swallow the next append", () => {
  const { b, makeBuffer, run, taken } = bufferMaker();
  const { sb } = makeBuffer(b, "audio/mp4");
  sb.remove(0, 10);
  sb.abort();
  sb.appendBuffer([3]);
  run();
  assert.deepEqual(taken, [[1, [3]]]);
});

test("a buffer added after one was removed gets a fresh ID, and removal reaches the native side", () => {
  const { b, makeBuffer } = bufferMaker();
  const first = makeBuffer(b, "video/mp4");
  const second = makeBuffer(b, "audio/mp4");
  b.states.splice(0, 1);
  b.buffers.splice(0, 1);
  const third = makeBuffer(b, "video/mp4");
  assert.deepEqual([first.st.id, second.st.id, third.st.id], [1, 2, 3]);
  const removal = between(pageScript, "      SourceProto.removeSourceBuffer = ", "      const sourceGetter = ");
  assert.match(removal, /st\.op\+\+;/);
  assert.match(removal, /sendMedia\(b, \{ op: "dropBuffer", media: b\.id, buffer: st\.id \}\);/);
  const adding = between(pageScript, "      SourceProto.addSourceBuffer = ", "      SourceProto.removeSourceBuffer = ");
  assert.match(adding, /if \(b\.bufferSeq >= MAX_BUFFER_ID\) throw new DOMException\(/);
  const nativeLimit = Number(between(native, "- (void)buffer:(NSDictionary *)message {", "\n}\n").match(/@"buffer", 1, (\d+), &buffer/)[1]);
  assert.equal(Number(pageScript.match(/const MAX_BUFFER_ID = (\d+);/)[1]), nativeLimit);
  assert.match(native, /if \(\[op isEqualToString:@"dropBuffer"\]\) return \[self dropBuffer:message\];/);
  const drop = between(native, "- (void)dropBuffer:(NSDictionary *)message {", "\n}\n");
  assert.match(drop, /\[_tracks removeObjectForKey:@\(buffer\)\];/);
  assert.match(drop, /removeFrom:-1e6 to:1e8 position:\[self position\]\];/);
});
