import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false, lastQuitAt: 1000 }));
stub.docs.delete("telemetry-queue.json");
const posted = [];
globalThis.fetch = async (_url, init) => (posted.push(String(init?.body ?? "")), { status: 200 });

const { flush, setSharing, startClient } = await import("./client.ts");
const { consentNow } = await import("./choice.ts");
const { endSessionForQuit, reopenSessionAfterCancelledQuit } = await import("./sessionQuit.ts");
after(() => setSharing(false, "settings"));

const sessionEnds = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "app_session_ended").length;

test("the held ended event goes with the consent it was captured under: turning sharing off drops it", async () => {
  startClient();
  endSessionForQuit({ duration_minutes: 3 }, consentNow());
  assert.equal(sessionEnds(), 1);
  setSharing(false, "settings");
  assert.equal(sessionEnds(), 0);
  await flush();
  assert.ok(!posted.some((body) => body.includes("app_session_ended")));
  assert.equal(reopenSessionAfterCancelledQuit(), true, "a cancel after the drop still reopens the session");
});

test("a quit that ends with a consent from before sharing was turned off and on again queues nothing", async () => {
  setSharing(true, "settings");
  const stale = consentNow();
  setSharing(false, "settings");
  setSharing(true, "settings");
  endSessionForQuit({ duration_minutes: 4 }, stale);
  assert.equal(sessionEnds(), 0);
  reopenSessionAfterCancelledQuit();
});
