import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const probe = fileURLToPath(new URL("./tests/reachabilityProbe.mjs", import.meta.url));
const loader = new URL("../../test-loader.mjs", import.meta.url).href;
const run = promisify(execFile);

const RUNS = ["mac", "windows", "linux"].flatMap((platform) => [false, true].map((glass) => ({ platform, glass })));
const results = RUNS.map(({ platform, glass }) =>
  run(process.execPath, ["--no-warnings", "--import", loader, probe], {
    env: { ...process.env, ARDIA_TEST_PLATFORM: platform === "mac" ? "" : platform, ARDIA_TEST_GLASS: glass ? "1" : "0" },
    maxBuffer: 1 << 24,
  }).then(({ stdout }) => JSON.parse(stdout)),
);

RUNS.forEach(({ platform, glass }, i) => {
  test(`every result Settings search offers on ${platform}${glass ? " with Liquid Glass" : ""} reaches a mounted row, and its unlocking setting reaches an enabled control`, async () => {
    assert.deepEqual(await results[i], []);
  });
});
