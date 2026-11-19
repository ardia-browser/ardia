import assert from "node:assert/strict";
import { test } from "node:test";
import { reloadToPlay as shared } from "./wakeReload.ts";
import { reloadToPlay as onWindows } from "./wakeReload.windows.ts";

const handle = (withToPlay) => {
  const calls = [];
  const page = { reload: async (...args) => void calls.push(["reload", args]) };
  if (withToPlay) page.reloadToPlay = async (...args) => void calls.push(["reloadToPlay", args]);
  return { page, calls };
};

test("the shared wake reload calls reload with no argument, so the Mac and Linux engines get what they always did", async () => {
  const { page, calls } = handle(true);
  await shared(page);
  assert.deepEqual(calls, [["reload", []]]);
});

test("on Windows the wake reload asks the page view for reloadToPlay, which arms the engine's one play", async () => {
  const { page, calls } = handle(true);
  await onWindows(page);
  assert.deepEqual(calls, [["reloadToPlay", []]]);
});

test("on Windows a page view without reloadToPlay still reloads", async () => {
  const { page, calls } = handle(false);
  await onWindows(page);
  assert.deepEqual(calls, [["reload", []]]);
});
