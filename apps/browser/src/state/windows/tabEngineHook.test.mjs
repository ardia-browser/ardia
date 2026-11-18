import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useTabEngine } = await import("./card.ts");

const S = () => useBrowser.getState();

function countingUrls() {
  const Real = globalThis.URL;
  let made = 0;
  globalThis.URL = new Proxy(Real, { construct: (target, args) => (made++, new target(...args)) });
  return { made: () => made, stop: () => void (globalThis.URL = Real) };
}

test("thirty open pages don't parse their urls again on a title change elsewhere", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const ids = [S().windows[w].tabIds[0]];
  for (let i = 0; i < 29; i++) ids.push(S().newTab(w, { url: `https://site${i}.com/page/${i}`, background: true }));
  const hooks = ids.map((id) => mount(() => useTabEngine(id)));
  hooks.forEach((h) => h.value);
  const urls = countingUrls();
  for (let i = 0; i < 10; i++) S().updateTab(ids[3], { title: `Inbox (${i})` });
  hooks.forEach((h) => h.value);
  urls.stop();
  assert.ok(urls.made() <= 2, `ten title writes parsed ${urls.made()} urls`);
});

test("a page's engine still follows its own engine, its site's rule and the default", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const id = S().newTab(w, { url: "https://b.com/x", background: true });
  const hook = mount(() => useTabEngine(id));
  assert.equal(hook.value, "chromium");
  S().updateSettings({ websiteEngines: { "https://b.com": "webkit" } });
  assert.equal(hook.value, "webkit", "a site rule");
  S().updateSettings({ websiteEngines: {} });
  assert.equal(hook.value, "chromium");
  S().updateTab(id, { engine: "webkit" });
  assert.equal(hook.value, "webkit", "the tab's own engine");
  S().updateTab(id, { engine: undefined });
  S().updateSettings({ pageEngine: "webkit" });
  assert.equal(hook.value, "webkit", "the default engine");
});
