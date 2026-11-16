import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { useToasts } = await import("../app/toasts.ts");
const { runSidebarCommand } = await import("./commands.ts");
const { runCommand } = await import("../commands/commands.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const toast = (w) => useToasts.getState().toasts[w];

function windowWith(...hosts) {
  S().hydrate({});
  useToasts.setState({ toasts: {} });
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("Move to Pinned shows which space the tab was pinned to, and moving it back says it was unpinned", () => {
  const { w, ids } = windowWith("a", "b");
  S().activate(ids[1]);
  const space = S().profiles[S().tabs[ids[1]].profileId].name;
  runSidebarCommand("togglePinnedRow", null, w);
  assert.ok(S().tabs[ids[1]].pin);
  assert.equal(toast(w)?.title, `Pinned Tab to "${space}"`);
  runSidebarCommand("togglePinnedRow", null, w);
  assert.equal(S().tabs[ids[1]].pin, null);
  assert.equal(toast(w)?.title, `Un-Pinned Tab from "${space}"`);
});

test("the togglePin command shows the toast, and moving a pinned row to Top Apps shows none", () => {
  const { w, ids } = windowWith("a");
  const space = S().profiles[S().tabs[ids[0]].profileId].name;
  runCommand({ command: "togglePin", arg: "row", windowId: w });
  assert.equal(toast(w)?.title, `Pinned Tab to "${space}"`);
  useToasts.setState({ toasts: {} });
  runCommand({ command: "togglePin", arg: "tile", windowId: w });
  assert.equal(toast(w), undefined);
});
