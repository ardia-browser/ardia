import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
await import("../../test-native/index.ts");
const { Animated, View } = await import("react-native");
Animated.View = View;
const observed = "file:///virtual/observeIconStrip.mjs";
registerHooks({
  resolve: (specifier, context, next) => (specifier === "../sidebar/IconStrip" && context.parentURL?.endsWith("IconStripDock.tsx") ? { url: observed, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url === observed ? { format: "module", source: "export const IconStrip = (props) => { globalThis.observedStripActions = props.actions; return null; };", shortCircuit: true } : next(url, context)),
});
const { IconStripDock } = await import("./IconStripDock.tsx");
const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
const { takeDockCounts } = await import("../../state/telemetry/dockCounts.ts");

test("a strip drag pressed with sharing off and begun after opting in floats the sidebar out without counting a peek", () => {
  const peek = { current: { live: false, show() { this.live = true; }, slide: new Animated.Value(0) } };
  renderToStaticMarkup(createElement(IconStripDock, { windowId: "w", shown: true, moving: false, fullscreen: false, right: false, peek }));
  setConsentPeriod(false, null);
  const drag = globalThis.observedStripActions.drag("t:a");
  drag.press();
  setConsentPeriod(true, "new-opt-in");
  takeDockCounts();
  drag.begin(20, 80);
  const counted = takeDockCounts().sidebar_icon_strip_peeks;
  drag.end(false);
  setConsentPeriod(false, null);
  assert.equal(peek.current.live, true);
  assert.equal(counted ?? 0, 0);
});

test("a folder or group square pressed with sharing off and released after opting in floats the sidebar out without counting a peek", () => {
  for (const item of [{ kind: "group", key: "g:none", groupId: "none" }, { kind: "live", key: "lf:none", folderId: "none" }]) {
    const peek = { current: { live: false, show() { this.live = true; }, slide: new Animated.Value(0) } };
    renderToStaticMarkup(createElement(IconStripDock, { windowId: "w", shown: true, moving: false, fullscreen: false, right: false, peek }));
    setConsentPeriod(false, null);
    const actions = globalThis.observedStripActions;
    const pressedWith = actions.pressed();
    setConsentPeriod(true, "opted-in-while-held");
    takeDockCounts();
    actions.open(item, pressedWith);
    const counted = takeDockCounts().sidebar_icon_strip_peeks;
    setConsentPeriod(false, null);
    assert.equal(peek.current.live, true, item.kind);
    assert.equal(counted ?? 0, 0, item.kind);
  }
});
