import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-threads-2-test");

after(() => S().updateSettings({ cliControl: false }));

const { call, ok } = socketClient(301);

test("tabs.forward answers the real result: failed when no forward ran, ok once the page went forward", async () => {
  const { tab } = await freshWindow();
  assert.equal((await call("tabs.forward", { tab })).error?.code, "failed", "no page, so nothing went forward");
  let forwards = 0;
  webviews.set(tab, { goForward: () => (forwards++, Promise.resolve()) });
  try {
    assert.equal((await ok("tabs.forward", { tab })).ok, true);
    assert.equal(forwards, 1);
  } finally {
    webviews.delete(tab);
  }
});

test("a failed apply counts as a socket-call failure", async () => {
  await freshWindow();
  takeCliCounts();
  const reply = await ok("apply", { ops: [{ op: "tab.close", tabs: ["nope"] }] });
  assert.equal(reply.ok, false);
  assert.equal(takeCliCounts().cli_socket_call_failures, 1);
});
