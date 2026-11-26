import assert from "node:assert/strict";
import { test } from "node:test";
import { Animated } from "react-native";
import { Symbol as NativeSymbol } from "@ardia/shell";
import { mount } from "../../test-hooks.mjs";
import { reduceMotionKnown } from "../ui/reduceMotion.ts";
import * as tokens from "./tokens.ts";
import { NAVIGATION_GLYPH_WEIGHT as desktopWeight } from "../../lib/platformChrome.desktop.ts";

globalThis.require ??= (id) => ({ asset: id });
const { HistoryButton, ReloadButton } = await import("./NavButtons.tsx");

await reduceMotionKnown;

function collectSymbols(node, out = [], contexts = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectSymbols(child, out, contexts);
    return out;
  }
  const { type, props } = node;
  if (type === NativeSymbol) {
    out.push({ name: props.name, size: props.size, weight: props.weight, color: props.color, style: props.style });
    return out;
  }
  if (type && typeof type === "object" && "Provider" in type && "value" in (props ?? {})) {
    collectSymbols(props.children, out, [...contexts, [type, props.value]]);
    return out;
  }
  if (type && typeof type === "object" && "$$typeof" in type && type.type) {
    const rendered = mount((p) => type.type(p), { props, contexts });
    try {
      collectSymbols(rendered.value, out, contexts);
    } finally {
      rendered.unmount();
    }
    return out;
  }
  if (typeof type === "function") {
    const rendered = mount((p) => type(p), { props, contexts });
    try {
      const next = rendered.value ?? (typeof props?.children === "function" ? props.children({ pressed: false }) : props?.children);
      collectSymbols(next, out, contexts);
    } finally {
      rendered.unmount();
    }
    return out;
  }
  if (typeof props?.children === "function") {
    collectSymbols(props.children({ pressed: false }), out, contexts);
  } else if (props?.children) {
    collectSymbols(props.children, out, contexts);
  }
  return out;
}

function findPressHandler(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPressHandler(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof node.props?.onPress === "function") return node.props.onPress;
  return node.props?.children ? findPressHandler(node.props.children) : null;
}

function assertNavGlyph(symbol, expectedName, expectedColor) {
  assert.equal(symbol.name, expectedName);
  assert.equal(symbol.size, tokens.GLYPH);
  assert.equal(symbol.weight, expectedName === "xmark" ? "medium" : "semibold");
  assert.equal(symbol.color, expectedColor);
  assert.deepEqual(symbol.style, { width: tokens.SYMBOL_BOX, height: tokens.SYMBOL_BOX });
}

const palette = {
  background: null,
  text: "#ffffff",
  secondary: "#ffffff80",
  icon: "#f7f5ffc6",
  iconDisabled: "#f7f5ff4d",
  hover: "rgba(255,255,255,0.1)",
  pressed: "rgba(255,255,255,0.18)",
  pill: "rgba(255,255,255,0.07)",
  divider: "rgba(255,255,255,0.09)",
};

const noop = () => {};
const plainClick = { shiftKey: false, metaKey: false, altKey: false, ctrlKey: false };

test("Mac navigation is semibold, desktop navigation and stop stay medium", () => {
  assert.deepEqual(tokens.NAV_GLYPH, { size: tokens.GLYPH, weight: "semibold" });
  assert.equal(desktopWeight, "medium");
  const cases = [
    { loading: false, url: "https://example.com", color: palette.icon },
    { loading: true, url: "https://example.com", color: palette.icon },
    { loading: false, url: "", color: palette.iconDisabled },
  ];
  for (const { loading, url, color } of cases) {
    const reload = mount((p) => ReloadButton.type(p), {
      props: { tab: { id: "t1", url, windowId: "w1" }, loading, palette, onFocus: noop, reloadHint: undefined },
    });
    try {
      const symbols = collectSymbols(reload.value);
      assert.equal(symbols.length, 2);
      assertNavGlyph(symbols[0], "arrow.clockwise", color);
      assertNavGlyph(symbols[1], "xmark", color);
    } finally {
      reload.unmount();
    }
  }
});

test("back and forward use NAV_GLYPH at rest, disabled and across both handoff layers while animating", async () => {
  const realTiming = Animated.timing;
  let finishHandoff;
  Animated.timing = () => ({
    start(done) {
      finishHandoff = done;
    },
    stop() {},
    reset() {},
  });
  try {
    for (const [direction, expectedName] of [
      [-1, "chevron.left"],
      [1, "chevron.right"],
    ]) {
      const disabledHistory = mount((p) => HistoryButton.type(p), {
        props: { tabId: "t1", windowId: "w1", direction, disabled: true, palette, onFocus: noop, historyHint: undefined },
      });
      try {
        const disabledSymbols = collectSymbols(disabledHistory.value);
        assert.equal(disabledSymbols.length, 1);
        assertNavGlyph(disabledSymbols[0], expectedName, palette.iconDisabled);
      } finally {
        disabledHistory.unmount();
      }

      finishHandoff = undefined;
      const history = mount((p) => HistoryButton.type(p), {
        props: { tabId: "t1", windowId: "w1", direction, disabled: false, palette, onFocus: noop, historyHint: undefined },
      });
      try {
        const resting = collectSymbols(history.value);
        assert.equal(resting.length, 1);
        assertNavGlyph(resting[0], expectedName, palette.icon);

        const onPress = findPressHandler(history.value);
        assert.equal(typeof onPress, "function");
        await onPress(plainClick);
        const handoff = collectSymbols(history.value);
        assert.equal(handoff.length, 2);
        assertNavGlyph(handoff[0], expectedName, palette.icon);
        assertNavGlyph(handoff[1], expectedName, palette.icon);

        assert.equal(typeof finishHandoff, "function");
        finishHandoff({ finished: true });
        const settled = collectSymbols(history.value);
        assert.equal(settled.length, 1);
        assertNavGlyph(settled[0], expectedName, palette.icon);
      } finally {
        history.unmount();
      }
    }
  } finally {
    Animated.timing = realTiming;
  }
});
