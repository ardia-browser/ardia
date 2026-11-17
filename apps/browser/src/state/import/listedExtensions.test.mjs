import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const id = (c) => c.repeat(32);
const ext = (c, name, more = {}) => ({ id: id(c), name, webStoreUrl: `https://chromewebstore.google.com/detail/${id(c)}`, enabled: true, ...more });
const SOURCE_EXTENSIONS = {
  Default: [ext("f", "Clip Saver", { pinnedIndex: 0 }), ext("g", "Tab Notes", { enabled: false }), ext("i", "Old Toolbar", { skip: "manifestV2" })],
  "Profile 1": [ext("f", "Clip Saver"), ext("h", "Focus Timer", { pinnedIndex: 0 })],
};
const engineCalls = [];
let installedInPersonal = [];

globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys() {},
    cancelImport() {},
    listExtensions: async (_browserId, profileId) => JSON.stringify(SOURCE_EXTENSIONS[profileId] ?? []),
    importData: async (_job, browserId, profileId) =>
      JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0,
        spaces: [], favorites: [], favicons: [], failed: [], warnings: [],
        profile: { name: profileId === "Default" ? "Personal" : "Work" },
      }),
  },
  ArdiaExtensions: {
    addListener: () => ({ remove() {} }),
    call: async (verb, profile) => {
      engineCalls.push(verb);
      if (verb !== "list") throw new Error(`unexpected ${verb}`);
      return JSON.stringify({ extensions: profile === "" ? installedInPersonal.map((x) => ({ id: x, name: x })) : [] });
    },
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { useImportFlow } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const { openListedExtensionsInStore, openExtensionStorePage } = await import("./listedExtensions.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");

const S = () => useBrowser.getState();
const step = () => useImportFlow.getState().step;

async function importChrome(sourceProfiles = ["Default", "Profile 1"]) {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  const profile = (pid) => ({ id: pid, name: pid === "Default" ? "Personal" : "Work", path: pid, isDefault: pid === "Default", available: ["bookmarks"] });
  useImportFlow.setState({
    source: { id: "chrome", name: "Google Chrome", family: "chromium", requiresExport: false, needsKeychain: false, profiles: [profile("Default"), profile("Profile 1")] },
    sourceProfiles,
    spaces: [],
    target: "default",
    kinds: new Set(["bookmarks"]),
    step: { name: "choose", error: null },
  });
  await runImport(new Set(["bookmarks"]));
  const end = Date.now() + 5000;
  while (step().name !== "done" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

test("the done screen lists each profile's Web Store extensions for the profile it went to, and installs nothing", async () => {
  installedInPersonal = [id("g")];
  takeImportRuns();
  await importChrome();
  const listing = step().extensions.listing;
  assert.deepEqual(listing.targets.map((t) => [t.profileName, t.extensions.map((e) => e.name)]), [["Personal", ["Clip Saver"]], ["Work", ["Clip Saver", "Focus Timer"]]]);
  assert.deepEqual(listing.leftOut.map((e) => [e.name, e.reason]), [["Tab Notes", "installed"], ["Old Toolbar", "manifestV2"]]);
  assert.deepEqual([...new Set(engineCalls)], ["list"], "only the installed list is read: no sync state, no install");
  const counts = takeImportRuns();
  assert.deepEqual([counts.import_extensions_listed, counts.import_extensions_skipped_installed, counts.import_extensions_skipped_mv2], [3, 1, 1]);
  assert.equal(counts.import_extensions_installed, undefined);

  const before = Object.keys(S().tabs).length;
  openExtensionStorePage(listing.targets[1].profileId, listing.targets[1].extensions[1].webStoreUrl);
  openListedExtensionsInStore();
  assert.equal(Object.keys(S().tabs).length - before, 4);
  assert.equal(step().extensions.listing.storeOpened, true);
  const work = Object.values(S().profiles).find((p) => p.name === "Work");
  assert.equal(Object.values(S().tabs).filter((t) => t.profileId === work.id).length, 3, "Work's store pages open in Work");
  assert.equal(takeImportRuns().import_extension_store_pages_opened, 4);
});

test("only the source profiles picked for the import are listed: the default pick lists the default profile's alone", async () => {
  installedInPersonal = [];
  await importChrome(["Default"]);
  const listing = step().extensions.listing;
  assert.deepEqual(listing.targets.map((t) => [t.profileName, t.extensions.map((e) => e.name)]), [["Personal", ["Clip Saver", "Tab Notes"]]]);
  assert.ok(!Object.values(S().profiles).some((p) => p.name === "Work"), "Work wasn't imported, so nothing is listed for it");
});
