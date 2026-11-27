import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { setShortcutOverride } = await import("../settings/actions.ts");
const { setTourAnchorLocator, startToolTour, useTour, sidebarStopBody } = await import("./tour.ts");
const { shortcutHint } = await import("../commands/commandShortcuts.ts");

const sidebarStop = () => useTour.getState().stops.find((stop) => stop.id === "sidebar")?.body;

test("the tour's Room to focus stop names the shortcut Auto-Hide Tabs has now", async () => {
  useBrowser.getState().hydrate({});
  const windowId = useBrowser.getState().createWindow({ url: "https://start.example/" });
  setTourAnchorLocator(() => Promise.resolve({ x: 0, y: 0, width: 10, height: 10 }));

  await startToolTour(windowId);
  assert.equal(sidebarStop(), sidebarStopBody(shortcutHint("toggleSidebar")));
  assert.match(sidebarStop() ?? "", /S hides the sidebar/);

  setShortcutOverride("toggleSidebar", { key: "j", modifiers: ["command", "option"] });
  await startToolTour(windowId);
  const rebound = shortcutHint("toggleSidebar");
  assert.ok(rebound && rebound !== "⌘S", rebound);
  assert.equal(sidebarStop(), sidebarStopBody(rebound));
  assert.ok(sidebarStop()?.startsWith(`${rebound} hides the sidebar`));

  setShortcutOverride("toggleSidebar", { key: "", modifiers: [] });
  await startToolTour(windowId);
  assert.ok(sidebarStop()?.startsWith("Hide Tabs hides the sidebar"), sidebarStop());
});
