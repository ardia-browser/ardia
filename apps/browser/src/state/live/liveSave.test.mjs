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
