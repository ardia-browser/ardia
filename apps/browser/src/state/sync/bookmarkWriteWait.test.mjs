import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { reloadBookmarks, startBookmarks } = await import("../bookmarks/engineSync.ts");
const { bookmarksAdapter } = await import("./adapters.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a bookmark apply from sync returns only once Chrome has the change, so the save window starts after it", async () => {
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  const stop = startBookmarks();
  await settle();
  await reloadBookmarks();
  const id = S().addBookmark({ profileId: "default", url: "https://a.example/", title: "A" });
  await settle();
  const adapter = bookmarksAdapter("default");
  const { values } = await adapter.extract(() => undefined);
  const key = [...values.keys()][0];
  let release;
  stub.bookmarkModel.applyHeld = new Promise((resolve) => (release = resolve));
  let done = false;
  const applying = Promise.resolve(adapter.apply(new Map([[key, { ...values.get(key), t: "A renamed" }]]), new Set([key]), () => undefined, {})).then(() => (done = true));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(done, false, "still waiting on Chrome's write");
  assert.equal(stub.chromeBookmarks("").get(id).t, "A");
  release();
  stub.bookmarkModel.applyHeld = null;
  await applying;
  assert.equal(stub.chromeBookmarks("").get(id).t, "A renamed");
  stop();
});

test("a bookmark apply whose Chrome write doesn't finish in time reports failure, so nothing is settled or counted", async (t) => {
  stub.docs.clear();
  stub.bookmarkDbs.clear();
  const stop = startBookmarks();
  await settle();
  await reloadBookmarks();
  S().addBookmark({ profileId: "default", url: "https://b.example/", title: "B" });
  await settle();
  const adapter = bookmarksAdapter("default");
  const { values } = await adapter.extract(() => undefined);
  const key = [...values.keys()].find((k) => values.get(k).t === "B");
  stub.bookmarkModel.applyHeld = new Promise(() => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const applying = Promise.resolve(adapter.apply(new Map([[key, { ...values.get(key), t: "B renamed" }]]), new Set([key]), () => undefined, {}));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  assert.equal(await applying, false);
  t.mock.timers.reset();
  stub.bookmarkModel.applyHeld = null;
  stop();
});
