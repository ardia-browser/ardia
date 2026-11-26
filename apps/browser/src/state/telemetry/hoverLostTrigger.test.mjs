import assert from "node:assert/strict";
import { test } from "node:test";

const { hoverLostProperties } = await import("./hoverLost.ts");

test("a lost-hover episode names the click, key press or pointer move that found it, and anything else reads as a move", () => {
  const trigger = (value) => hoverLostProperties({ reason: "halfActive", trigger: value }, 0).trigger;
  assert.equal(trigger("click"), "click");
  assert.equal(trigger("key"), "key");
  assert.equal(trigger("move"), "move");
  assert.equal(trigger("recheck"), "move");
  assert.equal(trigger("https://private.example"), "move");
});
