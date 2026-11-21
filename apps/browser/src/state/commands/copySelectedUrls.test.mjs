import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("./commands.ts");
const { shellNativeModules } = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const copied = [];
shellNativeModules.ArdiaShell.copyText = (text) => void copied.push(text);

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  S().setFocusedWindow(w);
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("⇧⌘C with several tabs selected copies every selected tab's address, one per line", () => {
  const { w, ids: [a, b] } = windowWith("a", "b", "c");
  S().activate(a);
  S().setSelection(w, [a, b]);
  copied.length = 0;
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.deepEqual(copied, ["https://a.com/\nhttps://b.com/"]);
});

test("a copy aimed at one tab (an automation request) copies that tab, whatever the sidebar has selected", async () => {
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  S().activate(a);
  S().setSelection(w, [a, b]);
  copied.length = 0;
  runCommand({ command: "copyUrl", arg: null, windowId: w }, { tabId: c });
  runCommand({ command: "copyUrlAsMarkdown", arg: null, windowId: w }, { tabId: c });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied.length, 2);
  assert.match(copied[0], /^https:\/\/c\.com\/$/);
  assert.match(copied[1], /\(https:\/\/c\.com\/\)$/);
});
