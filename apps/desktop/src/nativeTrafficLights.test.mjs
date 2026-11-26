import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { drawsNativeTrafficLights, nativeLightsRequest, placeNativeTrafficLights } from "./nativeTrafficLights.ts";

const hostWith = (capabilities, calls = []) => ({
  bootstrap: { windowId: "main", profileId: "default", capabilities },
  invoke: async (method, args) => (calls.push([method, args]), null),
});

test("a host that draws real traffic lights is told where the shell reserved room for them", async () => {
  const calls = [];
  const host = hostWith(["shell.trafficLights"], calls);
  assert.equal(drawsNativeTrafficLights(host), true);
  await placeNativeTrafficLights("main", [25, 27], false, host, 1280);
  await placeNativeTrafficLights("main", [96, 20], false, host, 1280);
  assert.deepEqual(calls, [
    ["shell.trafficLights", { center: { x: 25, y: 27 }, hidden: false }],
    ["shell.trafficLights", { center: { x: 96, y: 20 }, hidden: false }],
  ]);
});

test("lights moved off the window hide, a right-hand sidebar mirrors them, and no place restores the default", () => {
  assert.equal(nativeLightsRequest([-200, 27], false, 1280)?.hidden, true);
  assert.deepEqual(nativeLightsRequest([25, 27], true, 1280), { center: { x: 1255, y: 27 }, hidden: false });
  assert.equal(nativeLightsRequest(null, false, 1280), null);
});

test("hosts without native lights, and other windows' places, never reach the host", async () => {
  const calls = [];
  await placeNativeTrafficLights("main", [25, 27], false, hostWith([], calls), 1280);
  await placeNativeTrafficLights("settings", [25, 27], false, hostWith(["shell.trafficLights"], calls), 1280);
  assert.deepEqual(calls, []);
  assert.equal(drawsNativeTrafficLights(hostWith([])), false);
});

test("the drawn SVG lights step aside when the host draws real ones", () => {
  const source = readFileSync(new URL("./TrafficLights.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(drawsNativeTrafficLights\(\) \|\| !trafficLightsShown\(/);
  const shell = readFileSync(new URL("./shims/shellBase.tsx", import.meta.url), "utf8");
  assert.match(shell, /await placeNativeTrafficLights\(id, center, trailing\);/);
});

test("a burst of places, as spamming ⌘S slides the sidebar, settles on the last one and never ends on a stale frame", async () => {
  const calls = [];
  const releases = [];
  const host = {
    bootstrap: { windowId: "main", profileId: "default", capabilities: ["shell.trafficLights"] },
    invoke: (method, args) => new Promise((resolve) => { calls.push([method, args]); releases.push(resolve); }),
  };
  const frames = [[25, 27], [-40, 27], [-200, 27], [-60, 27], [10, 27], [25, 27], [-200, 27], [96, 20]];
  const settled = Promise.all(frames.map((center) => placeNativeTrafficLights("main", center, false, host, 1280)));
  for (let turn = 0; turn < 10; turn++) {
    await new Promise(setImmediate);
    releases.shift()?.(null);
  }
  await settled;
  assert.deepEqual(calls.at(-1), ["shell.trafficLights", { center: { x: 96, y: 20 }, hidden: false }]);
  assert.ok(calls.length <= 2, `intermediate frames are dropped, sent ${calls.length}`);
  assert.deepEqual(calls[0], ["shell.trafficLights", { center: { x: 25, y: 27 }, hidden: false }]);
});
