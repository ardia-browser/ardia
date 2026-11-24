import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentReturns() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts")
    .map((e) => [e.properties.pip_activation_returns, e.properties.pip_activation_return_failures]);
}

test("PiP activation returns and failures are counted without window details and reset with the session", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  usage.notePiPActivationReturn(true);
  usage.notePiPActivationReturn(false);
  usage.notePiPActivationReturn(true);
  usage.sessionEnding();
  assert.deepEqual(await sentReturns(), [[3, 1]]);

  usage.sessionEnding();
  assert.deepEqual(await sentReturns(), [[3, 1]]);
});
