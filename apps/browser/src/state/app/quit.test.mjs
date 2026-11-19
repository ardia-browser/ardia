import assert from "node:assert/strict";
import { test } from "node:test";

const quit = await import("./quit.ts");

test("a save that throws before it returns a promise neither fails nor holds the quit, and the quit is answered", async () => {
  quit.saveBeforeQuit("folder", () => {
    throw new Error("the data folder can't be created");
  });
  let later = false;
  quit.saveBeforeQuit("slower", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    later = true;
  });
  const saves = await quit.finishQuitSaves(2_000);
  assert.ok(later, "the other saves still run to the end");
  assert.deepEqual(Object.keys(saves.finished).sort(), ["folder", "slower"], "each save is timed by name, a failed one too");
  assert.deepEqual(saves.unfinished, []);
  assert.ok(saves.finished.slower >= 5 && saves.ms < 1_000);
  let answered = false;
  await quit.answerQuitAfterSaves(2_000, () => (answered = true));
  assert.ok(answered);
});

test("a save still running at the deadline is named, and the quit is answered without it", async () => {
  let release = () => {};
  quit.saveBeforeQuit("slower", () => new Promise((resolve) => (release = resolve)));
  const saves = await quit.finishQuitSaves(30);
  assert.deepEqual(saves.unfinished, ["slower"]);
  assert.ok("folder" in saves.finished && !("slower" in saves.finished));
  assert.ok(saves.ms >= 25);
  const logged = [];
  const info = console.info;
  console.info = (line) => logged.push(line);
  let answered = false;
  try {
    await quit.answerQuitAfterSaves(30, () => (answered = logged.length === 1), 7);
  } finally {
    console.info = info;
    release();
  }
  assert.ok(answered, "the line is written before the quit is answered, while the log still listens");
  assert.match(logged[0], /^\[quit\] last saves: session flushed in 7 ms, folder in \d+ ms; gave up on slower after \d+ ms$/);
});

test("the quit line names each save with its time and no page, address or title", () => {
  assert.equal(quit.quitSavesLine(12, { ms: 140, finished: { sync: 140, "shared folders": 0 }, unfinished: [] }), "[quit] last saves: session flushed in 12 ms, sync in 140 ms, shared folders in 0 ms");
  assert.equal(quit.quitSavesLine(3, { ms: 3000, finished: { "shared folders": 1 }, unfinished: ["sync"] }), "[quit] last saves: session flushed in 3 ms, shared folders in 1 ms; gave up on sync after 3000 ms");
  assert.equal(quit.quitSavesLine(0, { ms: 0, finished: {}, unfinished: [] }), "[quit] last saves: session flushed in 0 ms");
});
