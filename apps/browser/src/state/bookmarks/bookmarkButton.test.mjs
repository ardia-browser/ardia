import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../browser/store.ts");
const { bookmarkTab, useBookmarkDialog } = await import("./actions.ts");
const { startBookmarks, reloadBookmarks } = await import("./engineSync.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const URL = "https://deep.example/";

test("the bookmark button edits a page saved 70 folders deep instead of adding it again, in its own profile", async () => {
  S().hydrate({});
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  const stop = startBookmarks();
  await new Promise((r) => setTimeout(r, 0));
  await reloadBookmarks();
  let parentId;
  for (let i = 0; i < 70; i++) parentId = S().addBookmarkFolder({ profileId: "default", title: `F${i}`, parentId });
  const saved = S().addBookmark({ profileId: "default", url: URL, title: "Deep", parentId });
  const windowId = S().createWindow({ url: URL });
  const tabId = S().windows[windowId].tabIds[0];
  const before = Object.keys(S().bookmarks.nodes).length;

  assert.equal(bookmarkTab(windowId, tabId), "edited");
  assert.equal(Object.keys(S().bookmarks.nodes).length, before);
  assert.deepEqual(useBookmarkDialog.getState().open, { kind: "page", windowId, profileId: "default", bookmarkId: saved, added: false });
  stop();
});
