import assert from "node:assert/strict";
import { test } from "node:test";
import { docs } from "../../test-native/index.ts";

const store = await import("./store.ts");

test("a live folder change made just before quit is written by the final flush", () => {
  docs.delete("live.json");
  const id = store.createFolder("p", "pullRequests");
  assert.equal(docs.get("live.json"), undefined);
  store.flushLive();
  const saved = JSON.parse(docs.get("live.json"));
  assert.deepEqual(saved.folderOrder, [id]);
  assert.equal(saved.folders[id].name, "Pull Requests");
});

test("flushing with nothing pending writes nothing", () => {
  store.flushLive();
  docs.delete("live.json");
  store.flushLive();
  assert.equal(docs.get("live.json"), undefined);
});

test("refetching a settled folder with nothing new does not rewrite the file", () => {
  const item = () => ({ id: "settled", source: "github", url: "https://example.test/settled", title: "Settled", subtitle: "", icon: null, updatedAt: 0 });
  const id = store.createFolder("p", "pullRequests");
  store.applyFetch(id, [item()], {}, 1);
  store.flushLive();
  docs.delete("live.json");
  store.applyFetch(id, [item()], {}, 2);
  store.flushLive();
  store.applyFetch(id, [item()], {}, 3);
  store.flushLive();
  assert.equal(docs.get("live.json"), undefined);
});

test("a refresh that brings back the same items keeps the folder's items, known and unread as they were", () => {
  const items = [1, 2].map((n) => ({ id: `same:${n}`, source: "github", url: `https://example.test/${n}`, title: `${n}`, subtitle: "", icon: null, updatedAt: n }));
  const id = store.createFolder("p", "pullRequests");
  store.applyFetch(id, items, {}, 1);
  store.applyFetch(id, items, {}, 2);
  const before = store.live();
  let notified = 0;
  const stop = store.useLive.subscribe((s, prev) => void (s.items !== prev.items || s.known !== prev.known || s.unread !== prev.unread ? notified++ : 0));
  store.applyFetch(id, [...items], {}, 3);
  stop();
  const after = store.live();
  assert.equal(after.items, before.items);
  assert.equal(after.known, before.known);
  assert.equal(after.unread, before.unread);
  assert.equal(after.status[id].lastFetch, 3);
  assert.equal(notified, 0);
  store.applyFetch(id, [{ ...items[0], title: "renamed" }, items[1]], {}, 4);
  assert.notEqual(store.live().items, before.items);
  assert.equal(store.live().items[id][0].title, "renamed");
});
