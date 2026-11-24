import assert from "node:assert/strict";
import { test } from "node:test";
import { Animated, animations } from "react-native";
const { gateLevel, gatedNode } = await import("./motion.ts");

const SOURCE_VALUES = [0, 1, 0.5, 0.0001, 0.9999, -12, 240, -240, 1e-9, 1 - 1e-9];

test("a closed gate gives exactly the rest value whatever the source still takes", () => {
  for (const rest of [0, 1]) {
    const gate = new Animated.Value(gateLevel(false));
    const source = new Animated.Value(0.3);
    const node = gatedNode(gate, source, rest);
    for (const value of SOURCE_VALUES) {
      source.setValue(value);
      assert.ok(Object.is(node.__getValue(), rest), `rest ${rest}, source ${value}: got ${node.__getValue()}`);
    }
  }
});

test("an open gate passes the source through", () => {
  for (const rest of [0, 1]) {
    const gate = new Animated.Value(gateLevel(true));
    const source = new Animated.Value(0);
    const node = gatedNode(gate, source, rest);
    for (const value of SOURCE_VALUES) {
      source.setValue(value);
      assert.ok(Math.abs(node.__getValue() - value) < 1e-12, `rest ${rest}, source ${value}: got ${node.__getValue()}`);
    }
  }
});

test("closing the gate mid-animation pins the node to rest while the source keeps moving", () => {
  const gate = new Animated.Value(gateLevel(true));
  const slide = new Animated.Value(1);
  const opacity = gatedNode(gate, slide, 1);
  const shift = gatedNode(gate, slide, 0);
  animations.held = true;
  Animated.timing(slide, { toValue: 0 }).start();
  animations.step(slide, 0.7);
  assert.equal(opacity.__getValue(), 0.7);
  gate.setValue(gateLevel(false));
  for (const value of [0.6, 0.4, 0.2, 0.05]) {
    animations.step(slide, value);
    assert.ok(Object.is(opacity.__getValue(), 1));
    assert.ok(Object.is(shift.__getValue(), 0));
  }
  animations.finish();
  animations.held = false;
  assert.ok(Object.is(opacity.__getValue(), 1));
  assert.ok(Object.is(shift.__getValue(), 0));
  gate.setValue(gateLevel(true));
  slide.setValue(0.25);
  assert.equal(opacity.__getValue(), 0.25);
  assert.equal(shift.__getValue(), 0.25);
});
