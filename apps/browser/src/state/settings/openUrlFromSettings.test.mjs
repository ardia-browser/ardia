import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openUrlFromSettings } = await import("./settingsWindows.ts");

const S = () => useBrowser.getState();
const tabsAt = (url) => Object.values(S().tabs).filter((tab) => tab.url === url).length;

test("a link from Settings opens only in a regular window, and says whether it opened", () => {
  S().hydrate({});
  S().createWindow({ kind: "private", url: "https://secret.example/" });
  assert.equal(openUrlFromSettings("https://release.example/"), false, "only a private window is open");
  assert.equal(tabsAt("https://release.example/"), 0);
  S().createWindow({ url: "https://a.example/" });
  assert.equal(openUrlFromSettings("https://release.example/"), true);
  assert.equal(tabsAt("https://release.example/"), 1);
});
