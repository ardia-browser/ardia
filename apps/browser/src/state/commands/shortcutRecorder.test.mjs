import assert from "node:assert/strict";
import { test } from "node:test";
import { shortcutRecorder } from "./shortcutRecorder.ts";

const pending = () => {
  const calls = [];
  const record = () => new Promise((resolve) => calls.push(resolve));
  return { calls, record };
};
const J = { key: "j", modifiers: ["command"] };

test("a second click while a shortcut is being recorded starts no second recording", async () => {
  const { calls, record } = pending();
  let cancels = 0;
  const recorder = shortcutRecorder(record, () => void cancels++);
  const first = recorder.take();
  assert.equal(recorder.recording, true);
  assert.equal(await recorder.take(), undefined);
  assert.equal(calls.length, 1);
  calls[0](J);
  assert.deepEqual(await first, J);
  assert.equal(recorder.recording, false);
  assert.equal(cancels, 0);
});

test("leaving the row cancels the recording, and a chord that arrives after is never applied", async () => {
  const { calls, record } = pending();
  let cancels = 0;
  const recorder = shortcutRecorder(record, () => void cancels++);
  const taken = recorder.take();
  recorder.stop();
  assert.equal(cancels, 1);
  assert.equal(recorder.recording, false);
  calls[0](J);
  assert.equal(await taken, undefined);
  recorder.stop();
  assert.equal(cancels, 1);
});

test("after one recording ends the next click records again", async () => {
  const { calls, record } = pending();
  const recorder = shortcutRecorder(record, () => {});
  const first = recorder.take();
  calls[0](null);
  assert.equal(await first, null);
  const second = recorder.take();
  assert.equal(calls.length, 2);
  calls[1](J);
  assert.deepEqual(await second, J);
});

test("a recording that fails lets the next click record again", async () => {
  let attempts = 0;
  const recorder = shortcutRecorder(() => (++attempts === 1 ? Promise.reject(new Error("host refused")) : Promise.resolve(J)), () => {});
  await assert.rejects(recorder.take(), /host refused/);
  assert.equal(recorder.recording, false);
  assert.deepEqual(await recorder.take(), J);
  assert.equal(attempts, 2);
});
