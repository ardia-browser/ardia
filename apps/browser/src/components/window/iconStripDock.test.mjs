import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
await import("../../test-native/index.ts");
const { Animated, View } = await import("react-native");
Animated.View = View;
const observed = new URL("./virtualObservedStrip.mjs", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === "../sidebar/IconStrip" && context.parentURL?.endsWith("IconStripDock.tsx") ? { url: observed, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url === observed ? { format: "module", source: "export const IconStrip = (props) => { globalThis.observedStripActions = props.actions; return null; };", shortCircuit: true } : next(url, context)),
});
const { useBrowser } = await import("../../state/browser/store.ts");
const { IconStripDock } = await import("./IconStripDock.tsx");
const S = () => useBrowser.getState();

function mounted() {
  const peek = { current: { live: false, shows: 0, show() { this.shows++; this.live = true; }, slide: new Animated.Value(0) } };
  renderToStaticMarkup(createElement(IconStripDock, { windowId: "w", shown: true, moving: false, fullscreen: false, right: false, peek }));
  return { peek, actions: globalThis.observedStripActions };
}

test("hovering the strip floats nothing: the dock has no pointer-enter handler, only the icons' own tooltips", () => {
  const source = readFileSync(new URL("./IconStripDock.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /onMouseEnter|onMouseLeave|createStripHover|DWELL/);
});

test("a closed folder's icon opens it in the strip without floating the sidebar; a Top Apps or live folder, whose contents only the sidebar shows, still floats it", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().newTab(w, { url: "https://b.example/", background: true });
  const g = S().createGroup([b], { name: "Docs" });
  S().updateGroup(g, { collapsed: true });
  const { peek, actions } = mounted();
  actions.open({ kind: "group", key: `g:${g}`, groupId: g, color: null, open: false, bars: [] });
  assert.equal(S().groups[g].collapsed, false);
  assert.equal(peek.current.shows, 0);
  actions.open({ kind: "live", key: "lf:x", liveFolderId: "x" });
  assert.equal(peek.current.shows, 1);
});

test("dragging an icon still floats the sidebar so the tab can land in a folder", () => {
  const { peek, actions } = mounted();
  const drag = actions.drag("t:a");
  drag.press();
  drag.begin(20, 80);
  drag.end(false);
  assert.equal(peek.current.shows, 1);
});
