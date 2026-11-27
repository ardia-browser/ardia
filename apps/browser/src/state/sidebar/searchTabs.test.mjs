import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const { searchCandidates } = await import("./searchTabs.ts");
const { recentlyClosedIn } = await import("../windows/recentlyClosedList.ts");

const S = () => useBrowser.getState();
const closedTitles = (windowId) => searchCandidates(windowId).closed.map((r) => r.title);

function closeNamedGroup(windowId, name) {
  const a = S().newTab(windowId, { url: `https://${name.toLowerCase()}-a.example/` });
  const b = S().newTab(windowId, { url: `https://${name.toLowerCase()}-b.example/` });
  S().closeGroup(S().createGroup([a, b], { name }));
}

test("Search Tabs lists only the closed groups of the window's own profile", () => {
  const home = S().createWindow({ url: "https://search-home.example/" });
  const secret = S().createProfile({ name: "Search Secret" });
  const elsewhere = S().createWindow({ url: "https://search-secret.example/", profileId: secret });
  closeNamedGroup(elsewhere, "Secret");
  closeNamedGroup(home, "Mine");

  const inHome = closedTitles(home);
  const inElsewhere = closedTitles(elsewhere);
  assert.ok(inHome.includes("Mine"), inHome.join(", "));
  assert.ok(!inHome.includes("Secret"), inHome.join(", "));
  assert.ok(inElsewhere.includes("Secret"), inElsewhere.join(", "));
  assert.ok(!inElsewhere.includes("Mine"), inElsewhere.join(", "));
});

test("Search Tabs lists the same closed groups as the window's Recently Closed menu", () => {
  const home = S().createWindow({ url: "https://search-same-home.example/" });
  const other = S().createProfile({ name: "Search Same" });
  const elsewhere = S().createWindow({ url: "https://search-same-other.example/", profileId: other });
  closeNamedGroup(elsewhere, "Theirs");
  closeNamedGroup(home, "Ours");
  const incognito = S().createWindow({ kind: "private", url: "https://search-same-private.example/" });
  for (const windowId of [home, elsewhere, incognito]) {
    const groupRows = searchCandidates(windowId).closed.filter((r) => r.group).map((r) => r.id);
    const menuGroups = recentlyClosedIn(S(), S().windows[windowId]).groups.map((c) => c.id);
    assert.deepEqual(new Set(groupRows), new Set(menuGroups), windowId);
  }
});
