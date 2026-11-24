import assert from "node:assert/strict";
import { test } from "node:test";
const { CommandKeyLine } = await import("./SettingsSearch.tsx");

const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

test("a key hit keeps its command and keys on one line: the title truncates first and the keys never shrink", () => {
  const line = CommandKeyLine({ title: "New Little Ardia Window", keys: "⌥⌘N", color: "#fff" });
  assert.equal(flat(line.props.style).flexDirection, "row");
  const [title, keys] = [line.props.children].flat();
  assert.equal(title.props.lines, 1);
  assert.equal(title.props.children, "New Little Ardia Window");
  assert.equal(flat(title.props.style).flexShrink, 1);
  assert.equal(keys.props.lines, 1);
  assert.equal(flat(keys.props.style).flexShrink, 0);
  assert.equal(keys.props.children, " — ⌥⌘N", "the dash travels with the keys and never breaks from them");
});
