import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { runCommand } = await import("./commands.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setTimeout(r, 20));

async function findFrom(answer) {
  S().hydrate({});
  const w = S().createWindow({ url: "http://127.0.0.1:9/page" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, { evaluate: async () => answer });
  runCommand({ command: "useSelectionForFind", windowId: w });
  await settle();
  return S().find[tab];
}

test("Use Selection for Find opens Find only with a string the page returned", async () => {
  assert.equal((await findFrom("selected words"))?.query, "selected words");
  for (const answer of [["a", "b"], { length: 3 }, 42, true, null]) assert.equal((await findFrom(answer))?.open, undefined, JSON.stringify(answer));
  assert.equal((await findFrom("x".repeat(5000)))?.query.length, 500);
});
