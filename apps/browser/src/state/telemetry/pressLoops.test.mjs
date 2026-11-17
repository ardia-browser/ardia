import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
stub.docs.set("telemetry.json", JSON.stringify({ version: 99, sharing: true, installId: "loops", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: null, sessionOpen: false }));
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
client.loadChoice();
const { watchPressLoops } = await import("./pressLoops.ts");
watchPressLoops();
watchPressLoops();

const sent = () => {
  client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "press_loop_long");
};

test("a long press loop sends which loop, whether it was still open and whether a button was down, once per report", () => {
  stub.emitEvent("engine.pressLoopLong", { loop: "windowDragRegion", inner: "windowMove", open: true, buttonsHeld: false });
  const events = sent();
  assert.equal(events.length, 1, "watching twice still sends once");
  assert.deepEqual(
    Object.fromEntries(["loop", "inner", "still_open", "buttons_held"].map((k) => [k, events[0].properties[k]])),
    { loop: "windowDragRegion", inner: "windowMove", still_open: true, buttons_held: false },
  );
});

test("an unknown loop name is sent as other, never as given", () => {
  stub.emitEvent("engine.pressLoopLong", { loop: "https://private.example/page", inner: "Inbox", open: "yes", buttonsHeld: 1 });
  const event = sent().at(-1);
  assert.equal(event.properties.loop, "other");
  assert.equal(event.properties.inner, "other");
  assert.equal(event.properties.still_open, false);
  assert.equal(event.properties.buttons_held, false);
  assert.equal(JSON.stringify(event).includes("private.example"), false);
  assert.equal(JSON.stringify(event).includes("Inbox"), false);
});

test("at most 10 are sent in a session", () => {
  for (let i = 0; i < 20; i++) stub.emitEvent("engine.pressLoopLong", { loop: "windowMove", inner: "windowMove", open: false, buttonsHeld: true });
  assert.equal(sent().length, 10);
});
