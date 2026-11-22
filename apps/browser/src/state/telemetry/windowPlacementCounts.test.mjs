import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const placement = await import("./windowPlacementCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentPlacementCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.window_centered_resizes, e.properties.windows_reopened_maximized]);
}

test("an hour with only Option resizes still sends usage_counts, and the count starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  stub.emitAppEvent({ type: "centeredResize", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "centeredResize", epoch: client.consentEpoch() });
  usage.sessionEnding();
  assert.deepEqual(await sentPlacementCounts(), [[2, 0]]);

  usage.sessionEnding();
  assert.deepEqual(await sentPlacementCounts(), [[2, 0]]);
});

test("an hour with only drags Ardia moved itself still sends usage_counts with how many, and the count starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const sentDragLoops = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events.filter((e) => e.event === "usage_counts").map((e) => e.properties.window_drag_loops);
  };
  const before = (await sentDragLoops()).length;

  stub.emitAppEvent({ type: "windowDragLoop", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "windowDragLoop", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "windowDragLoop", epoch: client.consentEpoch() });
  usage.sessionEnding();
  assert.equal((await sentDragLoops()).at(-1), 3);

  usage.sessionEnding();
  assert.equal((await sentDragLoops()).length, before + 1, "an hour with no drag sends nothing more");
});

test("an hour with only a window reopened maximized still sends usage_counts", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  placement.noteWindowReopenedMaximized();
  usage.sessionEnding();
  assert.deepEqual((await sentPlacementCounts()).at(-1), [0, 1]);
});

test("an hour where a window switcher only read window titles still sends usage_counts, with how many windows", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  stub.emitAppEvent({ type: "windowTitleRead", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "windowTitleRead", epoch: client.consentEpoch() });
  usage.sessionEnding();
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  assert.equal(saved.events.filter((e) => e.event === "usage_counts").at(-1).properties.window_titles_read, 2);
});

test("window titles read and Option resizes from while sharing was off are never sent, and later ones are", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  stub.emitAppEvent({ type: "windowTitleRead", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "windowTitleRead", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "centeredResize", epoch: client.consentEpoch() });
  client.setSharing(true, "settings");
  usage.sessionEnding();
  await client.saveQueueNow();
  const sent = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "usage_counts");
  assert.ok(sent().every((e) => !e.properties.window_titles_read && !e.properties.window_centered_resizes));
  stub.emitAppEvent({ type: "windowTitleRead", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "centeredResize", epoch: client.consentEpoch() });
  usage.sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual([sent().at(-1).properties.window_titles_read, sent().at(-1).properties.window_centered_resizes], [1, 1]);
});

test("on Linux each window's decoration and the desktop's answer are counted by name, and unknown names are not", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  placement.noteLinuxWindowDecorations("compositor", "server");
  placement.noteLinuxWindowDecorations("app", "none");
  placement.noteLinuxWindowDecorations("app", "client");
  placement.noteLinuxWindowDecorations("toString", "__proto__");
  placement.noteLinuxWindowDecorations(undefined, 3);
  usage.sessionEnding();
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  const sent = saved.events.filter((e) => e.event === "usage_counts").at(-1).properties;
  assert.deepEqual(
    [sent.linux_windows_app_decorated, sent.linux_windows_compositor_decorated, sent.linux_decoration_answers_none, sent.linux_decoration_answers_client, sent.linux_decoration_answers_server],
    [2, 1, 1, 1, 1],
  );
  client.setSharing(false, "settings");
  placement.noteLinuxWindowDecorations("app", "none");
  assert.equal(placement.takeWindowPlacementCounts().linux_windows_app_decorated, 0);
});
