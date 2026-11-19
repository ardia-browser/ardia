import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false, lastQuitAt: 1000 }));
stub.docs.delete("telemetry-queue.json");
const posted = [];
globalThis.fetch = async (_url, init) => (posted.push(String(init?.body ?? "")), { status: 200 });

const { capture, flush, setSharing, startClient } = await import("./client.ts");
const { consentNow, sessionId } = await import("./choice.ts");
const { endSessionForQuit, reopenSessionAfterCancelledQuit } = await import("./sessionQuit.ts");
after(() => setSharing(false, "settings"));

const state = () => JSON.parse(stub.docs.get("telemetry.json"));
const queuedNames = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.map((e) => e.event);
const sessionEnds = () => queuedNames().filter((name) => name === "app_session_ended").length;

test("a quit closes the saved session and keeps its ended event on disk, but never sends it while the quit can still be cancelled", async () => {
  startClient();
  const session = sessionId();
  capture("app_launched", {}, consentNow());
  endSessionForQuit({ duration_minutes: 3 }, consentNow());
  assert.equal(state().sessionOpen, false);
  assert.ok(state().lastQuitAt > 1000);
  assert.equal(sessionEnds(), 1);
  await flush();
  assert.ok(posted.some((body) => body.includes("app_launched")), "the other events are sent");
  assert.ok(!posted.some((body) => body.includes("app_session_ended")), "the ended event went out while the quit could still be cancelled");
  assert.equal(sessionEnds(), 1, "the ended event stays queued for the next launch to send");
  assert.equal(sessionId(), session);
});

test("a cancelled quit reopens the same session, puts the last quit time back, and takes the ended event out of the queue", async () => {
  const session = sessionId();
  assert.equal(reopenSessionAfterCancelledQuit(), true);
  assert.equal(state().sessionOpen, true);
  assert.equal(state().sessionId, session);
  assert.equal(state().lastQuitAt, 1000);
  assert.equal(sessionEnds(), 0);
  assert.equal(reopenSessionAfterCancelledQuit(), false, "a second cancel without a quit changes nothing");
});

test("a final quit, the same shared code on every platform, ends the session once and leaves the event on disk for the next launch", async () => {
  posted.length = 0;
  endSessionForQuit({ duration_minutes: 5 }, consentNow());
  assert.equal(sessionEnds(), 1);
  assert.equal(state().sessionOpen, false);
  await flush();
  assert.ok(!posted.some((body) => body.includes("app_session_ended")));
});

test("the next launch sends the ended event of a final quit and reads the last session as clean", async () => {
  posted.length = 0;
  const nextLaunch = await import("./client.ts?next-launch");
  const launched = nextLaunch.startClient();
  assert.equal(launched.previous, "clean");
  await nextLaunch.flush();
  assert.equal(posted.filter((body) => body.includes("app_session_ended")).length, 1);
  assert.equal(sessionEnds(), 0);
});
