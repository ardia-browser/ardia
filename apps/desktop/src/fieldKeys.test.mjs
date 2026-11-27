import assert from "node:assert/strict";
import test from "node:test";

const { fieldKeyDown } = await import("./shims/react-native.tsx");
const press = (key, extra = {}) => ({ key, repeat: false, keyCode: 0, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, nativeEvent: { isComposing: false }, ...extra });
const SEARCH_KEYS = [{ key: "Escape" }, { key: "Enter" }];

test(`a held Escape in a field reaches its handler once, so the empty split pane's first Esc only clears the query (${process.env.ARDIA_DESKTOP_MODE ?? "linux"})`, () => {
  const presses = [press("Escape"), press("Escape", { repeat: true }), press("Escape", { repeat: true })];
  assert.deepEqual(presses.map((p) => fieldKeyDown(p, SEARCH_KEYS)), ["handle", "swallow", "swallow"]);
  assert.equal(fieldKeyDown(press("Escape"), SEARCH_KEYS), "handle", "a fresh press after the release still reaches it");
  assert.equal(fieldKeyDown(press("Enter", { repeat: true }), SEARCH_KEYS), "handle", "other keys still repeat");
});

test("Escape that an input method is composing with never reaches the field's handler", () => {
  assert.equal(fieldKeyDown(press("Escape", { nativeEvent: { isComposing: true } }), SEARCH_KEYS), "ignore");
  assert.equal(fieldKeyDown(press("Process", { keyCode: 229 }), SEARCH_KEYS), "ignore");
  assert.equal(fieldKeyDown(press("Escape", { keyCode: 229 }), SEARCH_KEYS), "ignore");
  assert.equal(fieldKeyDown(press("Escape", { nativeEvent: { isComposing: true } })), "ignore", "nor a field without a key filter");
  assert.equal(fieldKeyDown(press("a")), "pass");
  assert.equal(fieldKeyDown(press("a"), SEARCH_KEYS), "ignore");
});
