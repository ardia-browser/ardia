import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { shortcutHint, useShortcutHints, NAV_HINTS } = await import("../../state/commands/commandShortcuts.ts");

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const between = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined);

test("a pane reads the window's settings from its card, so a tab switch reads them once per card, not once per mounted pane", () => {
  const pane = source("./TabPane.tsx");
  for (const hook of ["useTabsShown(", "useSidebarField(", "useCardFrame(", "useToolbarRow(", "useSettings("]) assert.ok(!pane.includes(hook), `TabPane calls ${hook}`);
  const card = source("./ContentCard.tsx");
  for (const prop of ["sidebarFieldOpen={", "cardRadius={", "toolbarHeight={", "newTabCard={", "activeTabId={activeId}", "fullscreenTabId={fullscreenTab}"]) assert.ok(card.includes(prop), `ContentCard passes ${prop}`);
  const peek = between(source("../peek/PeekOverlay.tsx"), "export function PeekOverlay", "function PeekCard");
  assert.ok(!/useActiveTabId\(|useFullscreenTab\(/.test(peek), "PeekOverlay takes the active and fullscreen tab from its card");
});

test("a tab switch renders the card once: the lingering New Tab is derived, not set during render", () => {
  const layout = source("./usePaneLayout.ts");
  assert.ok(!/\bsetLinger\(\{/.test(layout), "usePaneLayout sets no state while rendering");
  assert.match(layout, /useMemo\(\(\) => \{\n    const from = shownBefore\.current;/);
});

test("the toolbar skips renders with unchanged props and reads its shortcut hints once", () => {
  const toolbar = source("../toolbar/Toolbar.tsx");
  assert.match(toolbar, /export const Toolbar = memo\(function Toolbar\(/);
  assert.equal((toolbar.match(/useShortcutHint\("(toggleSidebar|openSplitPane)"\)/g) ?? []).length, 0);
  const nav = source("../toolbar/NavButtons.tsx");
  assert.ok(!nav.includes("useShortcutHint("), "the back, forward and reload buttons take their hint from their toolbar");
});

test("drop targets read the drag in one selector while no tab is dragged", () => {
  const drop = between(source("../split/SplitChrome.tsx"), "export function DropTargets", "const hit =");
  assert.equal((drop.match(/useTabDrag\(/g) ?? []).length, 1);
});

test("shared shortcut hints match each command's own hint and keep their identity while nothing changes", () => {
  const hook = mount(() => useShortcutHints(NAV_HINTS));
  const first = hook.value;
  for (const id of NAV_HINTS) assert.equal(first[id], shortcutHint(id));
  assert.equal(hook.rerender(), first);
});
