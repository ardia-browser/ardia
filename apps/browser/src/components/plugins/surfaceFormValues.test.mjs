import assert from "node:assert/strict";
import { test } from "node:test";
import { formValues } from "./surfaceFormValues.ts";

const field = (type, props) => ({ type, props, children: [] });

test("a controlled field submits the plugin's value, not an edit the plugin didn't take", () => {
  const name = field("TextField", { id: "name", value: "Alice" });
  assert.deepEqual(formValues([name], { name: "Alice " }), { name: "Alice" });
});

test("an uncontrolled field submits what was typed, or its default before any edit", () => {
  const note = field("TextField", { id: "note", defaultValue: "hi" });
  assert.deepEqual(formValues([note], {}), { note: "hi" });
  assert.deepEqual(formValues([note], { note: "typed" }), { note: "typed" });
});

test("a controlled toggle and select follow the plugin, and a select never submits a value it doesn't offer", () => {
  const on = field("Toggle", { id: "on", value: false });
  const pick = field("Select", { id: "pick", value: "b", options: [{ value: "a" }, { value: "b" }] });
  assert.deepEqual(formValues([on, pick], { on: true, pick: "a" }), { on: false, pick: "b" });
  const gone = field("Select", { id: "pick", options: [{ value: "a" }, { value: "c" }] });
  assert.deepEqual(formValues([gone], { pick: "b" }), { pick: "a" });
});
