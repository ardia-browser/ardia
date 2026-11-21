import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./InWindowPlayer.tsx", import.meta.url), "utf8");

test("a Picture in Picture click skip reports the consent epoch taken when the press began, not when it was released", () => {
  assert.match(source, /\{ kind: "drag"; pointer: number; start: Point; rect: Rect; travel: number; samples: [^}]*\}\[\]; epoch: string \}/);
  assert.match(source, /: \{ kind: "drag", pointer: event\.pointerId, start: point, rect, travel: 0, samples: \[[^\]]*\], epoch: consentEpoch\(\) \}/);
  assert.match(source, /notePictureInPictureClickSkip\(\{ seconds: skip, epoch: current\.epoch \}\)/);
  assert.equal(source.match(/consentEpoch\(\)/g)?.length, 1, "the epoch is read only at pointer down");
});
