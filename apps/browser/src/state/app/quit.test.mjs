import assert from "node:assert/strict";
import { test } from "node:test";

const quit = await import("./quit.ts");

test("a save that throws before it returns a promise neither fails nor holds the quit, and the quit is answered", async () => {
  quit.saveBeforeQuit(() => {
    throw new Error("the data folder can't be created");
  });
  let later = false;
  quit.saveBeforeQuit(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    later = true;
  });
  await quit.finishQuitSaves(2_000);
  assert.ok(later, "the other saves still run to the end");
  let answered = false;
  await quit.answerQuitAfterSaves(2_000, () => (answered = true));
  assert.ok(answered);
});

test("each save starts while the quit is being answered, so what it notes before its first wait lands before the session ends", async () => {
  let started = false;
  quit.saveBeforeQuit(async () => {
    started = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const done = quit.finishQuitSaves(2_000);
  assert.ok(started, "the save began before finishQuitSaves returned");
  await done;
});
