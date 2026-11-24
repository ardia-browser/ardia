import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NATIVE_FADE_PROPS, nativeFadeProps } from "../../../../packages/phone/src/fadeProps.ts";

const LAYOUT_PROPS = new Set([
  "top", "bottom", "left", "right", "start", "end", "inset", "insetBlock", "insetInline", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "margin", "marginTop", "marginBottom", "marginLeft", "marginRight", "marginStart", "marginEnd", "marginHorizontal", "marginVertical",
  "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "paddingStart", "paddingEnd", "paddingHorizontal", "paddingVertical",
  "position", "flex", "flexGrow", "flexShrink", "flexBasis", "flexDirection", "flexWrap", "alignItems", "alignSelf", "alignContent", "justifyContent",
  "display", "overflow", "aspectRatio", "direction", "zIndex", "gap", "rowGap", "columnGap", "borderWidth", "opacity", "transform",
]);

const declared = (path: string) => [...readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/Prop\("(\w+)"\)/g)].map((match) => match[1]!).sort();

test("Android's fade props never share a name with a React Native layout prop, which the new architecture hands to the view by the same name", () => {
  for (const name of Object.values(NATIVE_FADE_PROPS)) assert.equal(LAYOUT_PROPS.has(name), false, `${name} is a layout prop`);
  const sent = Object.keys(nativeFadeProps({ top: { length: 8 }, bottom: { length: 12, floor: 0.2 }, leading: { length: 4 }, trailing: { length: 6 } })).sort();
  assert.deepEqual(sent, declared("../../../../packages/phone/android/src/main/java/com/ardia/phone/FadeModule.kt"), "what JS sends is exactly what the Android module declares");
});

test("an edge left out is not sent, so a style's top or bottom never reaches a fade prop", () => {
  assert.deepEqual(nativeFadeProps({ trailing: { length: 6 } }), { trailingFade: { length: 6 } });
});

test("the iPhone module takes the safe names too, so both phones are sent the same props", () => {
  assert.deepEqual(declared("../../../../packages/phone/ios/FadeModule.swift"), Object.values(NATIVE_FADE_PROPS).sort());
  assert.deepEqual(declared("../../../../packages/phone/ios/FadeModule.swift"), declared("../../../../packages/phone/android/src/main/java/com/ardia/phone/FadeModule.kt"));
});
