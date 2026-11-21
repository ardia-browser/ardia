import assert from "node:assert/strict";
import { test } from "node:test";
import { topOwnFrames } from "./freeze-frames.ts";

test("a signature's place is its top frames from Ardia's own images, top first", () => {
  const frames = JSON.stringify([
    { function: "system + 0x10", in_app: false },
    { function: "Ardia + 0x4400", in_app: true },
    { function: "hermes + 0x1ae528", in_app: true },
    { function: "hermes + 0x1ae2a0", in_app: true },
    { function: "other + 0x0", in_app: false },
  ]);
  assert.deepEqual(topOwnFrames(frames), ["hermes + 0x1ae2a0", "hermes + 0x1ae528", "Ardia + 0x4400"]);
  assert.deepEqual(topOwnFrames("not json"), []);
});
