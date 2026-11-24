import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useStableHandler } = await import("./useStableHandler.ts");

test("a stable handler keeps its identity across renders and calls the latest props", () => {
  const calls = [];
  const hook = mount(({ tabId }) => useStableHandler(() => calls.push(tabId)), { props: { tabId: "a" } });
  const first = hook.value;
  assert.equal(hook.rerender({ tabId: "b" }), first, "a tab switch hands the Button the same handler");
  first();
  assert.deepEqual(calls, ["b"], "and it acts on the tab now shown");
});

test("the toolbar's back, forward, reload and sidebar buttons get no new handler or face on a tab switch", () => {
  const nav = readFileSync(new URL("./NavButtons.tsx", import.meta.url), "utf8");
  const buttons = nav.slice(nav.indexOf("export const ReloadButton"));
  assert.ok(!/\bon(Press|PressIn|PressOut|LongPress|ContextMenu|MiddleClick)=\{\(/.test(buttons), "no inline arrow handlers on the reload and history buttons");
  assert.match(buttons, /\{glyph\}/);
  assert.match(buttons, /\{face\}/);
  const toolbar = readFileSync(new URL("./Toolbar.tsx", import.meta.url), "utf8");
  const bar = toolbar.slice(toolbar.indexOf("export const Toolbar = memo"), toolbar.indexOf("export function ToolbarBackdrop"));
  assert.ok(!/<Button[^>]*onPress=\{\(\)/.test(bar), "the toolbar's own buttons take callbacks that keep their identity");
});

test("the address field keeps its handlers and palette while what it shows is unchanged", () => {
  const toolbar = readFileSync(new URL("./Toolbar.tsx", import.meta.url), "utf8");
  const field = toolbar.slice(toolbar.indexOf("function useUrlField"), toolbar.indexOf("const loadFillColor"));
  assert.match(field, /const openPanel = useStableHandler\(/);
  assert.match(field, /const toggleSiteControls = useStableHandler\(/);
  assert.match(toolbar, /const focus = useStableHandler\(/, "the toolbar hands its buttons and field one focus handler");
  const palette = readFileSync(new URL("./useSitePalette.ts", import.meta.url), "utf8");
  assert.match(palette, /samePalette\(kept\.current, palette\)/, "an equal palette keeps its identity");
});
