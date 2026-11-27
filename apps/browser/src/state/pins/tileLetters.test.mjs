import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { tabMenuItems } = await import("../sidebar/tabMenu.ts");
const { setTileLetters, showsTileLetters } = await import("./tileLetters.ts");
const { takeMinimalismCounts } = await import("../telemetry/minimalismCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "tile-letters-test");

const S = () => useBrowser.getState();
const customize = (w, id) => tabMenuItems(S(), w, S().tabs[id]).find((i) => i.id === "customize")?.children.filter((i) => i.title).map((i) => i.title) ?? [];

function tile() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.google.com/" });
  const id = S().windows[w].tabIds[0];
  S().newTab(w, { url: "https://b.example/" });
  S().pinTabs([id], true);
  return { w, id };
}

test("Change Letters… is in a Top Apps tile's menu only while Minimalism mode shows letters (#3609)", () => {
  const { w, id } = tile();
  assert.ok(!customize(w, id).includes("Change Letters…"), "not outside Minimalism mode");
  S().updateSettings({ minimalismMode: true });
  assert.ok(showsTileLetters(S(), S().tabs[id]));
  assert.ok(customize(w, id).includes("Change Letters…"));
  assert.ok(!customize(w, id).includes("Reset Letters"), "nothing to reset yet");
  setTileLetters(id, "gm", null);
  assert.ok(customize(w, id).includes("Reset Letters"));
  S().updateSettings({ minimalismPinnedIcons: "logos" });
  assert.ok(!customize(w, id).includes("Change Letters…"), "not with Site Logos");
  const row = S().windows[w].tabIds.find((t) => !S().tabs[t].pin);
  S().updateSettings({ minimalismPinnedIcons: "letters" });
  assert.ok(!customize(w, row).includes("Change Letters…"), "not on an unpinned tab");
});

test("setting, changing and resetting a tile's letters is saved on the tab and counted; the same letters again are not", () => {
  const { id } = tile();
  takeMinimalismCounts();
  setTileLetters(id, "gm", undefined);
  assert.equal(S().tabs[id].tileLetters, "GM");
  setTileLetters(id, "GM", undefined);
  setTileLetters(id, "abc", undefined);
  assert.equal(S().tabs[id].tileLetters, "AB");
  setTileLetters(id, null, undefined);
  assert.equal(S().tabs[id].tileLetters, undefined);
  const counts = takeMinimalismCounts();
  assert.equal(counts.tile_letters_set, 2);
  assert.equal(counts.tile_letters_reset, 1);
});

test("switching Minimalism tiles between letters and logos is counted; a value inferred at launch is not", () => {
  S().hydrate({});
  takeMinimalismCounts();
  S().updateSettings({ minimalismPinnedIcons: "logos" });
  S().updateSettings({ minimalismPinnedIcons: "logos" });
  S().updateSettings({ minimalismPinnedIcons: "letters" });
  const counts = takeMinimalismCounts();
  assert.equal(counts.minimalism_pinned_icons_logos, 1);
  assert.equal(counts.minimalism_pinned_icons_letters, 1);
});

test("Change Letters… opens the in-app letters panel, with no system dialog, on every platform", async () => {
  const { useSidebarUi } = await import("../sidebar/sidebarUi.ts");
  const { readFileSync } = await import("node:fs");
  const { w, id } = tile();
  S().updateSettings({ minimalismMode: true, minimalismPinnedIcons: "letters" });
  const { openTabMenu } = await import("../sidebar/tabMenu.ts");
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(shown.find((i) => i.id === "customize").children.find((i) => i.title === "Change Letters…").id);
  try {
    await openTabMenu(w, S().tabs[id]);
  } finally {
    shell.showMenu = real;
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(useSidebarUi.getState().tileLetters && { windowId: useSidebarUi.getState().tileLetters.windowId, tabId: useSidebarUi.getState().tileLetters.tabId }, { windowId: w, tabId: id });
  for (const file of ["./tileLetters.ts", "../../components/sidebar/TileLetters.tsx"]) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /platform\/dialogs|prompt\(/, file);
});

test("in the letters panel, Done with an empty field goes back to the site's letter, Cancel leaves the letters as they were", async () => {
  const { commitTileLetters, closeTileLetters, openTileLetters } = await import("./tileLetters.ts");
  const { useSidebarUi } = await import("../sidebar/sidebarUi.ts");
  const { w, id } = tile();
  setTileLetters(id, "GM", undefined);
  await openTileLetters(w, id);
  closeTileLetters();
  assert.equal(S().tabs[id].tileLetters, "GM", "Cancel keeps them");
  assert.equal(useSidebarUi.getState().tileLetters, null);
  await openTileLetters(w, id);
  commitTileLetters(id, "", undefined);
  assert.equal(S().tabs[id].tileLetters, undefined, "an empty Done resets them");
  assert.equal(useSidebarUi.getState().tileLetters, null, "and closes the panel");
  await openTileLetters(w, id);
  commitTileLetters(id, "xy", undefined);
  assert.equal(S().tabs[id].tileLetters, "XY");
});

test("with tabs on top, the letters panel anchors to the clicked pinned tab in the top strip", async () => {
  const { openTileLetters, registerStripTile } = await import("./tileLetters.ts");
  const { useSidebarUi } = await import("../sidebar/sidebarUi.ts");
  const { w, id } = tile();
  S().updateSettings({ tabLayout: "top" });
  const cell = { measureInWindow: (done) => done(212, 6, 40, 30) };
  registerStripTile(w, id, cell);
  await openTileLetters(w, id);
  assert.deepEqual(useSidebarUi.getState().tileLetters?.anchor, { x: 212, y: 6, width: 40, height: 30 });
  registerStripTile(w, id, null);
  await openTileLetters(w, id);
  assert.equal(useSidebarUi.getState().tileLetters?.anchor, null, "an unmounted cell leaves no stale anchor");
  assert.match((await import("node:fs")).readFileSync(new URL("../../components/tabstrip/PinnedDock.tsx", import.meta.url), "utf8"), /ref=\{\(v\) => registerStripTile\(windowId, tabId, v\)\}/);
});
