import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./layout.ts", import.meta.url), "utf8");

test("window layout hooks hear only their window's record and the settings, not every tab or page update", () => {
  const wholeStore = [...source.matchAll(/useBrowser\(\(s\) => ([a-zA-Z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(wholeStore.sort(), ["downloadsInSidebarFooter", "sidebarHeaderCollapsed"], "only the hooks that also read the profile order select from the whole store");
  assert.ok(!/s\.(tabs|live|history|peeks)\b/.test(source), "layout reads no per-tab state, so the window watch covers it");
  const hooks = readFileSync(new URL("../browser/hooks.ts", import.meta.url), "utf8");
  assert.match(hooks, /export const useTabsPlace = \(windowId: string\)[^\n]*useWindowSettings\(windowId,/);
  for (const hook of ["useTabLayout", "useSidebarSide", "useWindowFullScreen"]) {
    const line = hooks.split("\n").find((l) => l.startsWith(`export const ${hook} =`)) ?? "";
    assert.ok(line && !line.includes("useBrowser(("), `${hook} hears only its window and the settings`);
  }
});

test("tab layout, sidebar side and full screen follow their window and the settings, and sleep through tab updates", async () => {
  const { mount } = await import("../../test-hooks.mjs");
  const { useBrowser } = await import("../browser/store.ts");
  const { useSidebarSide, useTabLayout, useWindowFullScreen } = await import("../browser/hooks.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const hook = mount(() => ({ side: useSidebarSide(w), layout: useTabLayout(w), fullScreen: useWindowFullScreen(w), focusedSide: useSidebarSide() }));
  const renders = hook.renders;
  useBrowser.setState((s) => ({ tabs: { ...s.tabs } }));
  assert.equal(hook.renders, renders, "a tab update wakes none of them");
  useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarSide: "right" } }));
  assert.equal(hook.value.side, "right");
  assert.equal(hook.value.focusedSide, "right", "the focused window's side follows too");
  useBrowser.setState((s) => ({ windows: { ...s.windows, [w]: { ...s.windows[w], fullScreen: true, tabLayout: "top" } } }));
  assert.equal(hook.value.fullScreen, true);
  assert.equal(hook.value.layout, "top");
  hook.unmount();
});
