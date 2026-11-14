import assert from "node:assert/strict";
import { test } from "node:test";
import { type AutofillFrame, frameAllows, isSecureOrigin } from "./autofillFrames.ts";

type Frame = AutofillFrame & { destroyed: boolean; origin: string };
let nextToken = 1;

function frame(origin: string, top?: Frame): Frame {
  const made: Frame = { origin, frameToken: `t${nextToken++}`, processId: 4, routingId: nextToken, top: null, destroyed: false, isDestroyed: () => made.destroyed };
  Object.assign(made, { top: top ?? made });
  return made;
}

test("secure origins are https and the loopback hosts, as in Chrome", () => {
  for (const origin of ["https://shop.example", "http://localhost:8710", "http://127.0.0.1:8710", "http://[::1]:80", "http://app.localhost"]) assert.equal(isSecureOrigin(origin), true, origin);
  for (const origin of ["http://shop.example", "http://10.0.0.2", "null", "file://", "chrome-extension://abc"]) assert.equal(isSecureOrigin(origin), false, origin);
});

test("addresses fill in the top frame and same-origin frames, cards only on secure origins, never in a cross-origin frame", () => {
  const top = frame("https://shop.example");
  const same = frame("https://shop.example", top);
  const cross = frame("https://pay.example", top);
  const plain = frame("http://shop.example");
  const opaque = frame("null", top);
  assert.equal(frameAllows(top, "address"), true);
  assert.equal(frameAllows(top, "card"), true);
  assert.equal(frameAllows(same, "card"), true);
  assert.equal(frameAllows(cross, "address"), false);
  assert.equal(frameAllows(cross, "card"), false);
  assert.equal(frameAllows(plain, "address"), true);
  assert.equal(frameAllows(plain, "card"), false);
  assert.equal(frameAllows(opaque, "address"), false);
  assert.equal(frameAllows(null, "address"), false);
  same.destroyed = true;
  assert.equal(frameAllows(same, "address"), false);
});
