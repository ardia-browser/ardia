import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));
await import("../../test-native/index.ts");
const { Toggle } = await import("./Switch.tsx");

const findPress = (node) => {
  if (!node || typeof node !== "object") return null;
  if (node.props?.onPress) return node;
  for (const child of [].concat(node.props?.children ?? [])) {
    const found = findPress(child);
    if (found) return found;
  }
  return null;
};
const knobOf = (node) => {
  const fill = [].concat(node.props.children.props.children)[0];
  return fill.props.style[1].opacity;
};

function pressed(asksFirst) {
  let asked = null;
  const host = mount(() => {
    const toggle = Toggle({ value: false, asksFirst, onChange: (on) => void (asked = on) });
    return toggle.type(toggle.props);
  });
  const press = findPress(host.value);
  press.props.onPress();
  const progress = knobOf(press);
  return { asked, shown: progress.__getValue ? progress.__getValue() : progress._value, target: progress };
}

test("a switch that asks first stays off when pressed until its value changes; a plain switch slides at once", async () => {
  const asking = pressed(true);
  assert.equal(asking.asked, true, "the press still asks");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(asking.target.__getValue(), 0, "it hasn't moved toward on");
  const plain = pressed(false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(plain.target.__getValue() > 0, "a plain switch answers the press");
});
