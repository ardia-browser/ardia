import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const returns = await import("./pageFocusReturns.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => ({
      restored: e.properties.webkit_focus_restores,
      kept: e.properties.webkit_focus_restores_kept,
      refused: e.properties.webkit_focus_restores_refused,
      gaveUp: e.properties.webkit_focus_restores_gave_up,
    }));
}

test("a WebKit page taking the keyboard back is counted by outcome, unknown outcomes are ignored, and the counts start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  for (const outcome of ["focused", "focused", "focused", "kept", "refused", "gaveUp", "gaveUp", "unknown"]) returns.noteWebKitFocusRestore(outcome);
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [{ restored: 3, kept: 1, refused: 1, gaveUp: 2 }]);
  assert.deepEqual(returns.takePageFocusReturns(), {
    page_focus_returns_after_bar: 0,
    page_focus_return_requests_after_menu: 0,
    webkit_focus_restores: 0,
    webkit_focus_restores_kept: 0,
    webkit_focus_restores_refused: 0,
    webkit_focus_restores_gave_up: 0,
  });
});

async function sentMenuRequests() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => e.properties.page_focus_return_requests_after_menu);
}

test("a request to return page focus after a right-click menu is sent once in usage_counts, then counts from zero", async () => {
  client.setSharing(true, "onboarding");
  const before = (await sentMenuRequests()).length;
  returns.notePageFocusReturnRequestAfterMenu();
  returns.notePageFocusReturnRequestAfterMenu();
  usage.sessionEnding();
  assert.deepEqual((await sentMenuRequests()).slice(before), [2]);
  usage.sessionEnding();
  assert.equal((await sentMenuRequests()).length, before + 1);
});

test("menu focus requests need consent, and a count pending when sharing is turned off is dropped", async () => {
  client.setSharing(false, "settings");
  returns.notePageFocusReturnRequestAfterMenu();
  client.setSharing(true, "onboarding");
  assert.equal(returns.takePageFocusReturns().page_focus_return_requests_after_menu, 0, "nothing noted while sharing was off");
  returns.notePageFocusReturnRequestAfterMenu();
  client.setSharing(false, "settings");
  client.setSharing(true, "onboarding");
  assert.equal(returns.takePageFocusReturns().page_focus_return_requests_after_menu, 0, "turning sharing off drops what was pending");
});
