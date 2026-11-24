import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { COUNT_EVENTS } = await import("./countEvents.ts");
const { WHATS_SENT, LOCAL_COPY } = await import("./copy.ts");

const DESCRIBED_BY = {
  usage_counts: ["Usage", "How many times"],
  tab_presses: ["Usage", "How many tab presses"],
  password_import: ["Usage", "When you import passwords"],
  perf_omnibox: ["Speed", "command bar speed (a sample of keystrokes)"],
  perf_memory: ["Speed", "Memory use and the number of tabs, once an hour"],
  telemetry_local_store: ["The local copy", "Every hour while sharing is on, how much Ardia wrote to the local copy"],
};
const KIND = { Usage: "usage counts", Speed: "speed", "The local copy": "local-copy" };

test("every event refused without consent is described in What's Sent as a measurement, and Kept on this Mac says it isn't kept with sharing off", () => {
  assert.deepEqual([...COUNT_EVENTS].sort(), Object.keys(DESCRIBED_BY).sort());
  const exception = LOCAL_COPY.items.find((item) => item.startsWith("With sharing off"));
  for (const [event, [group, phrase]] of Object.entries(DESCRIBED_BY)) {
    const items = WHATS_SENT.find((g) => g.title === group)?.items ?? [];
    assert.ok(items.some((item) => item.includes(phrase)), `${event}: What's Sent › ${group} has no item with “${phrase}”`);
    assert.ok(exception.includes(KIND[group]), `${event}: Kept on this Mac doesn't say ${KIND[group]} aren't kept`);
  }
  assert.ok(exception.includes("memory"), "Kept on this Mac names the memory measurements");
});

test("the Mac and Linux report filters leave out the same events capture refuses", () => {
  const swift = readFileSync(new URL("../../../../../packages/shell/ios/UpdaterCore/LocalReportLines.swift", import.meta.url), "utf8");
  const listed = /countEvents: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1].match(/"([a-z_]+)"/g)?.map((s) => s.slice(1, -1));
  assert.deepEqual(listed?.sort(), [...COUNT_EVENTS].sort());
  const linux = readFileSync(new URL("../../../../linux/src/hostTelemetryLocal.ts", import.meta.url), "utf8");
  assert.match(linux, /import \{ COUNT_EVENTS \} from "\.\.\/\.\.\/browser\/src\/state\/telemetry\/countEvents"/);
});
