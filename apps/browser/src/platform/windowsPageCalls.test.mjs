import assert from "node:assert/strict";
import { test } from "node:test";
import { pageMethod } from "../../../../packages/expo-windows/src/engine/pageCalls.ts";

function host(answers = {}) {
  const received = [];
  const call = async (key, method, args) => {
    received.push([key, method, args]);
    const answer = answers[args.action ?? method];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: true, done: true };
  };
  return { call, received };
}

test("a media command goes to the host at once, with its action and seconds", async () => {
  const { call, received } = host();
  await pageMethod(call, "page-a", "mediaCommand")("seekTo", 20);
  assert.deepEqual(received, [["page-a", "mediaCommand", { action: "seekTo", seconds: 20 }]]);
});

test("a refused media command answers nothing", async () => {
  const { call } = host({ next: new Error("the page's media session does not take that") });
  assert.equal(await pageMethod(call, "page-c", "mediaCommand")("next"), null);
});

test("the engine's answer reaches the caller: done false when no session took the command, recorded for a wake's seek, byScript for the wake's play", async () => {
  const { call } = host({ play: { ok: true, done: false }, seekTo: { done: true, ok: true, recorded: true }, toggle: { byScript: true, done: true, ok: true } });
  const mediaCommand = pageMethod(call, "page-d", "mediaCommand");
  assert.deepEqual(await mediaCommand("play"), { done: false });
  assert.deepEqual(await mediaCommand("seekTo", 3), { done: true, recorded: true });
  assert.deepEqual(await mediaCommand("toggle"), { done: true, byScript: true });
});

test("a method the table does not know is left to the caller", () => {
  assert.equal(pageMethod(host().call, "page-e", "notAMethod"), null);
});
