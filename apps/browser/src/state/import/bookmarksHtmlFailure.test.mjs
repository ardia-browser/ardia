import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

const root = { type: "folder", title: "", children: [{ type: "folder", title: "Bookmarks bar", role: "toolbar", children: [{ type: "url", title: "A", url: "https://a.example/" }] }] };
globalThis.acTestNativeModules = {
  ArdiaImport: { addListener: () => ({ remove() {} }), chooseImportFile: async () => "/scratch/bookmarks.html", importBookmarksHTML: async () => JSON.stringify(root) },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startBookmarks } = await import("../bookmarks/engineSync.ts");
const { useProfileLoading } = await import("../profiles/profileLoading.ts");
const { importNow, patchImport } = await import("./flow.ts");
const { importBookmarksHtml } = await import("./fileImports.ts");

const S = () => useBrowser.getState();

test("a bookmarks file whose profile's bookmarks never load from Chrome shows bookmarks as failed on the done step (#2389)", async (t) => {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  stub.bookmarkModel.treeHangs = true;
  useProfileLoading.setState({ deferred: true, opened: {}, unloaded: {} });
  patchImport({ target: "default" });
  const stop = startBookmarks();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const done = importBookmarksHtml();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    t.mock.timers.tick(15_000);
    t.mock.timers.reset();
    await done;
    const step = importNow().step;
    assert.equal(step.name, "done");
    assert.equal(step.counts.bookmarks, 0);
    assert.deepEqual(step.failures, [{ kind: "bookmarks", profiles: [] }]);
  } finally {
    stop();
    stub.bookmarkModel.treeHangs = false;
    useProfileLoading.setState({ deferred: false, opened: {}, unloaded: {} });
  }
});
