import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
const { Pressable, View } = await import("react-native");
const { AddChip } = await import("./AddChip.tsx");
const { GoButton } = await import("./GoButton.tsx");

function faceOf(Button, props) {
  const shown = mount(() => Button.type(props), { props: {} });
  const pressable = shown.value.props.children;
  shown.unmount();
  assert.equal(pressable.type, Pressable);
  assert.equal(typeof pressable.props.children, "function");
  assert.equal(pressable.props.onPressIn, undefined, "no press-in animation");
  assert.equal(pressable.props.onPressOut, undefined, "no press-out animation");
  return (pressed) => pressable.props.children({ pressed });
}

const flat = (style) => (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style);

test("the bar's Go button is a plain View that answers the press with its pressed fill, no scale", () => {
  const face = faceOf(GoButton, { label: "Go", enabled: true, onPress() {} });
  const rest = face(false);
  const pressed = face(true);
  assert.equal(rest.type, View);
  assert.equal(pressed.type, View);
  assert.equal(flat(pressed.props.style).transform, undefined);
  assert.ok(flat(pressed.props.style).opacity < flat(rest.props.style).opacity, "pressed reads darker than rest");
});

test("the bar's Open a tab or file chip is a plain View that answers the press with its pressed fill, no scale", () => {
  const face = faceOf(AddChip, { onPress() {} });
  const rest = face(false);
  const pressed = face(true);
  assert.equal(rest.type, View);
  assert.equal(pressed.type, View);
  assert.equal(flat(pressed.props.style).transform, undefined);
  assert.notEqual(flat(pressed.props.style).backgroundColor, flat(rest.props.style).backgroundColor);
});
