import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { pageNamesItsProfile } = await import("./pageTitle.ts");

const S = () => useBrowser.getState();
const sidebarWindow = (settings) => {
  S().hydrate({});
  S().updateSettings({ addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false, ...settings });
  return S().createWindow({ url: "https://example.com/" });
};
const named = (w, profileId = S().windows[w].profileId) => pageNamesItsProfile(S(), w, profileId);

test("with one profile, no page names it, as Dia shows no profile button then", () => {
  assert.equal(named(sidebarWindow({})), false);
});

test("with the address bar in the sidebar and two profiles, each page names its own profile", () => {
  const w = sidebarWindow({});
  const work = S().createProfile({ name: "Work" });
  assert.equal(named(w), true);
  assert.equal(named(w, work), true);
  assert.equal(named(w, "missing"), false);
});

test("with the address bar on top the header already shows the name, so the pages don't", () => {
  const w = sidebarWindow({ addressBar: "toolbar" });
  S().createProfile({ name: "Work" });
  assert.equal(S().settings.addressBar, "toolbar");
  assert.equal(named(w), false);
});

test("horizontal tabs have no sidebar pages to name", () => {
  const w = sidebarWindow({ tabLayout: "top" });
  S().createProfile({ name: "Work" });
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(named(w), false);
});

test("a private window keeps its Incognito badge instead", () => {
  sidebarWindow({});
  S().createProfile({ name: "Work" });
  const p = S().createWindow({ kind: "private", url: "https://example.com/" });
  assert.equal(named(p), false);
});
