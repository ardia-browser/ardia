import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

const { checkedInput, INPUT_ACTIONS, isKeyName, MAX_COORDINATE, MAX_TEXT_LENGTH, MAX_WHEEL_DELTA } = await import("./tabInput.ts");
const { OpError } = await import("./workspaceTargets.ts");

const refused = (params, pattern) =>
  assert.throws(
    () => checkedInput(params),
    (error) => error instanceof OpError && error.code === "bad_request" && (!pattern || pattern.test(error.message)),
    JSON.stringify(params),
  );

test("each action takes only its own fields", () => {
  assert.deepEqual(checkedInput({ tab: "t", action: "click", x: 10, y: 20 }), { action: "click", x: 10, y: 20 });
  assert.deepEqual(checkedInput({ tab: "t", action: "down", x: 1, y: 2, button: "middle", clickCount: 2, modifiers: ["meta", "shift", "meta"] }), {
    action: "down",
    x: 1,
    y: 2,
    button: "middle",
    clickCount: 2,
    modifiers: ["shift", "meta"],
  });
  assert.deepEqual(checkedInput({ tab: "t", action: "wheel", x: 5, y: 5, deltaY: 120 }), { action: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 120 });
  assert.deepEqual(checkedInput({ tab: "t", action: "key", key: "Enter" }), { action: "key", key: "Enter" });
  assert.deepEqual(checkedInput({ tab: "t", action: "key", key: "a", code: "KeyA", modifiers: ["control"] }), { action: "key", key: "a", code: "KeyA", modifiers: ["control"] });
  assert.deepEqual(checkedInput({ tab: "t", action: "text", text: "héllo 👋\nworld" }), { action: "text", text: "héllo 👋\nworld" });
  refused({ action: "click", x: 1, y: 1, text: "x" }, /click takes/);
  refused({ action: "text", text: "x", x: 1 }, /text takes/);
  refused({ action: "key", key: "a", button: "left" }, /key takes/);
  refused({ action: "move", x: 1, y: 1, button: "left" }, /move takes/);
});

test("pointer actions need a finite point inside the coordinate bounds", () => {
  for (const action of ["click", "dblclick", "move", "down", "up"]) refused({ action }, /x must/);
  refused({ action: "wheel", deltaY: 1 }, /x must/);
  for (const bad of [-1, MAX_COORDINATE + 1, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
    refused({ action: "click", x: bad, y: 1 }, /x must/);
    refused({ action: "click", x: 1, y: bad }, /y must/);
  }
  assert.equal(checkedInput({ action: "click", x: MAX_COORDINATE, y: 0 }).x, MAX_COORDINATE);
});

test("buttons, click counts, modifiers and wheel deltas are checked", () => {
  refused({ action: "click", x: 1, y: 1, button: "back" }, /button/);
  refused({ action: "click", x: 1, y: 1, clickCount: 2 }, /click takes/);
  refused({ action: "dblclick", x: 1, y: 1, clickCount: 1 }, /dblclick takes/);
  assert.equal(checkedInput({ action: "up", x: 1, y: 1, clickCount: 2 }).clickCount, 2);
  refused({ action: "click", x: 1, y: 1, button: "right" }, /own menu/);
  refused({ action: "down", x: 1, y: 1, modifiers: ["control"] }, /own menu/);
  refused({ action: "wheel", x: 1, y: 1, deltaY: 10, modifiers: ["meta"] }, /zooms/);
  refused({ action: "wheel", x: 1, y: 1, deltaY: 10, modifiers: ["control"] }, /zooms/);
  assert.deepEqual(checkedInput({ action: "move", x: 1, y: 1, modifiers: ["control"] }).modifiers, ["control"]);
  assert.deepEqual(checkedInput({ action: "key", key: "a", modifiers: ["meta"] }).modifiers, ["meta"]);
  refused({ action: "down", x: 1, y: 1, clickCount: 4 }, /clickCount must/);
  refused({ action: "down", x: 1, y: 1, clickCount: 1.5 }, /clickCount must/);
  refused({ action: "click", x: 1, y: 1, modifiers: ["hyper"] }, /modifiers/);
  refused({ action: "click", x: 1, y: 1, modifiers: "shift" }, /modifiers/);
  refused({ action: "click", x: 1, y: 1, modifiers: ["shift", "shift", "shift", "shift", "shift"] }, /modifiers/);
  refused({ action: "wheel", x: 1, y: 1 }, /deltaX or deltaY/);
  refused({ action: "wheel", x: 1, y: 1, deltaY: MAX_WHEEL_DELTA + 1 }, /deltaY/);
  refused({ action: "wheel", x: 1, y: 1, deltaX: Number.NaN }, /deltaX/);
});

test("keys are one printable character or a key name, codes are key codes", () => {
  for (const key of ["a", "A", "1", " ", "é", "👋", "Enter", "Tab", "Backspace", "Escape", "ArrowLeft", "F5", "PageDown"]) assert.ok(isKeyName(key), key);
  for (const key of ["", "\n", "\r", "\0", "\u007f", " ", "﻿", "\ud800", "ab", "enter", "Enter\n", "x".repeat(40), 5, null]) assert.ok(!isKeyName(key), JSON.stringify(key));
  refused({ action: "key", key: "Enter", code: "key a" }, /code/);
  refused({ action: "key", key: "Enter", code: "" }, /code/);
  refused({ action: "key" }, /key must/);
  refused({ action: "key", key: "ContextMenu" }, /context menu/);
  refused({ action: "key", key: "a", code: "ContextMenu" }, /context menu/);
  refused({ action: "key", key: "F10", modifiers: ["shift"] }, /context menu/);
  assert.equal(checkedInput({ action: "key", key: "F10" }).key, "F10");
});

test("text is well-formed, NUL-free and bounded", () => {
  refused({ action: "text", text: "" }, /at least one/);
  refused({ action: "text", text: "x".repeat(MAX_TEXT_LENGTH + 1) }, /at most/);
  refused({ action: "text", text: "a\0b" }, /NUL/);
  refused({ action: "text", text: "a\ud800b" }, /well-formed/);
  refused({ action: "text", text: "\udc00" }, /well-formed/);
  assert.equal(checkedInput({ action: "text", text: "x".repeat(MAX_TEXT_LENGTH) }).text.length, MAX_TEXT_LENGTH);
});

test("an unknown action is refused before anything is sent", () => {
  for (const action of ["tap", "", "CLICK", "__proto__", "constructor", 1, null, undefined]) refused({ action, x: 1, y: 1 }, /action must/);
  assert.deepEqual([...INPUT_ACTIONS].sort(), ["click", "dblclick", "down", "key", "move", "text", "up", "wheel"]);
});

test("every hostile value through every field either is refused or reaches the engine in a safe shape", () => {
  const values = HOSTILE_VALUES.map((h) => h.value);
  const fields = ["action", "x", "y", "button", "clickCount", "modifiers", "deltaX", "deltaY", "key", "code", "text"];
  const bases = { click: { action: "click", x: 1, y: 1 }, wheel: { action: "wheel", x: 1, y: 1, deltaY: 3 }, key: { action: "key", key: "a" }, text: { action: "text", text: "ok" } };
  for (const base of Object.values(bases)) {
    for (const field of fields) {
      for (const value of values) {
        let out;
        try {
          out = checkedInput({ ...base, [field]: value });
        } catch (error) {
          assert.ok(error instanceof OpError && error.code === "bad_request", `${field}: only bad_request escapes`);
          continue;
        }
        assert.ok(INPUT_ACTIONS.includes(out.action));
        for (const [key, shown] of Object.entries(out)) {
          if (["x", "y", "deltaX", "deltaY", "clickCount"].includes(key)) assert.ok(typeof shown === "number" && Number.isFinite(shown), `${key} finite`);
          if (key === "modifiers") assert.ok(shown.every((m) => ["shift", "control", "alt", "meta"].includes(m)));
          if (key === "key") assert.ok(isKeyName(shown));
          if (key === "code") assert.match(shown, /^[A-Z][A-Za-z0-9]{1,31}$/);
          if (key === "button") assert.ok(["left", "middle"].includes(shown));
          if (key === "text") {
            assert.equal(typeof shown, "string");
            assert.ok(shown.length >= 1 && shown.length <= MAX_TEXT_LENGTH && !shown.includes("\0"));
            assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(shown), "no lone surrogate");
          }
        }
        assert.ok(!Object.keys(out).some((key) => key === "__proto__" || key === "constructor"));
      }
    }
  }
});
