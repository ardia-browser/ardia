import assert from "node:assert/strict";
import { test } from "node:test";
import { quit } from "./js-bench.mjs";

test("quit returns when the app can't be signalled, so a run's results are still written", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs a non-root Unix user" }, async (t) => {
  const said = [];
  t.mock.method(process.stderr, "write", (text) => (said.push(String(text)), true));
  const started = Date.now();
  await quit(1);
  assert.ok(Date.now() - started < 2000);
  assert.match(said.join(""), /js-bench: couldn't send SIGTERM to pid 1: EPERM/);
  await quit(2 ** 30);
});
