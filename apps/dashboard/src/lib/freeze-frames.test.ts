import assert from "node:assert/strict";
import { test } from "node:test";
import { topOwnFrames } from "./freeze-frames.ts";
import { frameKey, frameLabel, imageUuids, nativeFrame, unnamed } from "./native-frames.ts";

const APP = "6c57f7df-5c37-325c-8c92-a15c7007c150";
const ENGINE = "4c4c4449-5555-3144-a17c-2ebff056d510";

test("a signature's place is its top frames from Ardia's own images, top first", () => {
  const frames = JSON.stringify([
    { function: "system + 0x10", in_app: false },
    { function: "Ardia + 0x4400", in_app: true },
    { function: "hermes + 0x1ae528", in_app: true },
    { function: "hermes + 0x1ae2a0", in_app: true },
    { function: "other + 0x0", in_app: false },
  ]);
  assert.deepEqual(topOwnFrames(frames).map((f) => f.raw), ["hermes + 0x1ae2a0", "hermes + 0x1ae528", "Ardia + 0x4400"]);
  assert.deepEqual(topOwnFrames("not json"), []);
  assert.deepEqual(topOwnFrames("{}"), []);
});

test("own frames carry their image's UUID and offset, so they can be named", () => {
  const frames = JSON.stringify([
    { function: "Chromium Framework + 0x318e860", module: "Chromium Framework", image_offset: "0x318e860" },
    { function: "Ardia + 0x327180", module: "Ardia", image_offset: "0x327180" },
    { function: "system + 0x10", module: "system", image_offset: "0x10" },
  ]);
  const images = JSON.stringify([{ name: "Ardia", uuid: APP.toUpperCase() }, { name: "Chromium Framework", uuid: ENGINE }]);
  const top = topOwnFrames(frames, images);
  assert.deepEqual(top, [
    { raw: "Ardia + 0x327180", image: "Ardia", uuid: APP, offset: 0x327180 },
    { raw: "Chromium Framework + 0x318e860", image: "Chromium Framework", uuid: ENGINE, offset: 0x318e860 },
  ]);
  const names = new Map([[frameKey(APP, 0x327180), { symbol: "MenuTarget.undoOrReopenClosedTab(_:)", delta: 400 }]]);
  assert.deepEqual(top.map((f) => frameLabel(f, names)), ["MenuTarget.undoOrReopenClosedTab(_:) + 400", "Chromium Framework + 0x318e860"]);
  assert.deepEqual(unnamed([...top, ...top]).length, 2);
});

test("frames without a known image, or with a malformed offset, stay raw and aren't looked up", () => {
  const images = imageUuids(JSON.stringify([{ name: "Ardia", uuid: "not-a-uuid" }, { name: "Chromium Framework", uuid: ENGINE }]));
  assert.equal(images.size, 1);
  assert.deepEqual(nativeFrame({ function: "Ardia + 0x10", module: "Ardia", image_offset: "0x10" }, images), { raw: "Ardia + 0x10", image: "Ardia", uuid: null, offset: null });
  assert.equal(nativeFrame({ function: "x", module: "Chromium Framework", image_offset: "0x" }, images).offset, null);
  assert.equal(nativeFrame({ function: "x", module: "Chromium Framework", image_offset: "0x" + "f".repeat(14) }, images).offset, null);
  assert.equal(imageUuids("[{").size, 0);
  assert.equal(imageUuids(JSON.stringify([{ name: "Ardia", uuid: APP }, { name: "Ardia", uuid: ENGINE }])).size, 0);
});
