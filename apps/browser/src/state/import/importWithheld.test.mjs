import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

const link = (title, url) => ({ type: "url", title, url });
let failing = new Map();

globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    unlockBrowser: async () => {},
    isBrowserUnlocked: () => true,
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) => {
      if (failing.has(profileId)) throw Object.assign(new Error("The import failed"), { code: failing.get(profileId) });
      return JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0,
        spaces: [], favorites: [], favicons: [],
        bookmarks: { type: "folder", title: "Bookmarks", children: [{ type: "folder", title: "Bookmarks Toolbar", role: "toolbar", children: [link(profileId, `https://${profileId}.example/`)] }] },
        failed: [], warnings: [],
      });
    },
  },
};

const stub = await import("../../test-native/index.ts");
const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useImportFlow } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");

after(() => client.setSharing(false, "settings"));

const HELD_BACK = "what looked like a password, cookie or card number turned up where it shouldn't, so Ardia held it all back to keep it private. Importing again without passwords, cookies and cards should work.";

async function importFrom(profiles, failures) {
  failing = new Map(Object.entries(failures));
  useBrowser.setState({ bookmarks: { nodes: {} } });
  useBrowser.getState().hydrate({});
  useBrowser.getState().createWindow({ url: "https://start.example/" });
  const profile = (id) => ({ id, name: id, path: `/zen/${id}`, isDefault: id === profiles[0], available: ["bookmarks", "cookies"] });
  useImportFlow.setState({
    source: { id: "zen", name: "Zen", family: "firefox", requiresExport: false, needsKeychain: false, profiles: profiles.map(profile) },
    sourceProfiles: profiles,
    spaces: [],
    target: "default",
    kinds: new Set(["bookmarks", "cookies"]),
    step: { name: "choose", error: null },
  });
  await runImport(new Set(["bookmarks", "cookies"]));
  await new Promise((r) => setTimeout(r, 5));
  return useImportFlow.getState().step;
}

async function sentCounts() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return queue.events.filter((e) => e.event === "usage_counts").at(-1)?.properties ?? {};
}

test("an import the engine withheld for a secret says why on the done step and is counted", async () => {
  client.setSharing(true, "onboarding");
  const step = await importFrom(["default"], { default: "ERR_SECRET_IN_REPLY" });
  assert.equal(step.name, "done");
  assert.deepEqual(step.failures, [{ kind: "bookmarks", profiles: [] }, { kind: "cookies", profiles: [] }]);
  assert.deepEqual(step.notes, [`Nothing was imported: ${HELD_BACK}`]);
  const sent = await sentCounts();
  assert.equal(sent.import_withheld, 1);
  assert.equal(sent.import_kinds_failed, 2);
});

test("with several profiles, the note names the one held back and the others still import", async () => {
  const step = await importFrom(["work", "home"], { home: "ERR_SECRET_IN_REPLY" });
  assert.equal(step.name, "done");
  assert.deepEqual(step.failures, [{ kind: "bookmarks", profiles: ["home"] }, { kind: "cookies", profiles: ["home"] }]);
  assert.deepEqual(step.notes, [`Nothing from home was imported: ${HELD_BACK}`]);
  assert.equal(step.counts.bookmarks, 1);
  assert.equal((await sentCounts()).import_withheld, 1);
});

test("an import that fails for another reason adds no held-back note and counts nothing withheld", async () => {
  const step = await importFrom(["default"], { default: "unreadable" });
  assert.deepEqual(step.failures, [{ kind: "bookmarks", profiles: [] }, { kind: "cookies", profiles: [] }]);
  assert.deepEqual(step.notes, []);
  assert.equal((await sentCounts()).import_withheld, 0);
});
