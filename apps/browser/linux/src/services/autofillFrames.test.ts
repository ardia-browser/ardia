import assert from "node:assert/strict";
import { test } from "node:test";
import { type AutofillFrame, FillGrants, frameAllows, isSecureOrigin } from "./autofillFrames.ts";

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

test("values are released only for a suggestion main showed to that frame, once", () => {
  const grants = new FillGrants();
  const top = frame("https://shop.example");
  const other = frame("https://shop.example", top);
  assert.equal(grants.take(1, top, "card", "c1"), false);
  grants.offer(1, top, "card", ["c1", "c2"]);
  assert.equal(grants.take(1, top, "card", "c3"), false);
  grants.offer(1, top, "card", ["c1", "c2"]);
  assert.equal(grants.take(1, other, "card", "c1"), false);
  assert.equal(grants.take(2, top, "card", "c1"), false);
  assert.equal(grants.take(1, top, "address", "c1"), false);
  grants.offer(1, top, "card", ["c1", "c2"]);
  assert.equal(grants.take(1, top, "card", "c2"), true);
  assert.equal(grants.take(1, top, "card", "c2"), false);
});

test("a grant ends when its frame navigates, changes origin, goes away or waits too long", () => {
  const grants = new FillGrants();
  const top = frame("https://shop.example");
  grants.offer(1, top, "address", ["a1"]);
  grants.forgetFrame(1, top.processId, top.routingId);
  assert.equal(grants.take(1, top, "address", "a1"), false);
  grants.offer(1, top, "address", ["a1"]);
  top.origin = "https://elsewhere.example";
  assert.equal(grants.take(1, top, "address", "a1"), false);
  top.origin = "https://shop.example";
  grants.offer(1, top, "address", ["a1"]);
  grants.forgetContents(1);
  assert.equal(grants.take(1, top, "address", "a1"), false);
  grants.offer(1, top, "address", ["a1"], 0);
  assert.equal(grants.take(1, top, "address", "a1", 11 * 60_000), false);
  grants.offer(1, top, "address", ["a1"]);
  top.destroyed = true;
  assert.equal(grants.take(1, top, "address", "a1"), false);
});

test("a card grant isn't honored once its frame can't take cards", () => {
  const grants = new FillGrants();
  const top = frame("http://shop.example");
  grants.offer(1, top, "card", ["c1"]);
  assert.equal(grants.take(1, top, "card", "c1"), false);
});
