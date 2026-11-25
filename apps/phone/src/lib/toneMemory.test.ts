import assert from "node:assert/strict";
import test from "node:test";
import { parseRememberedTones, rememberedTonesText } from "./toneMemory.ts";

test("remembered page colours keep only open tabs and real colours, and survive a round trip", () => {
  const keep = new Set(["a", "b"]);
  const text = rememberedTonesText({ a: { top: "#11171D", bottom: "#2B5B83" }, b: { top: "javascript:", bottom: null }, gone: { top: "#FFFFFF", bottom: "#FFFFFF" } }, keep);
  assert.deepEqual(JSON.parse(text), { a: { top: "#11171D", bottom: "#2B5B83" } });
  assert.deepEqual(parseRememberedTones(text, keep), { a: { top: "#11171D", bottom: "#2B5B83" } });
  assert.deepEqual(parseRememberedTones(text, new Set(["b"])), {});
});

test("anything unreadable gives no remembered colours instead of failing the launch", () => {
  const keep = new Set(["a"]);
  for (const raw of [null, "", "{", "[]", "42", JSON.stringify({ a: "blue" }), JSON.stringify({ a: { top: 3 } })]) assert.deepEqual(parseRememberedTones(raw, keep), {});
});
