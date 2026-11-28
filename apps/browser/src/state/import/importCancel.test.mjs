import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");

const S = () => useBrowser.getState();
const P = "default";

const bigHistory = (count) =>
  Array.from({ length: count }, (_, i) => ({ url: `https://page${i}.example/`, title: `${i} ${"t".repeat(900_000)}`, visits: 1, lastVisit: 1_700_000_000_000 + i }));

test("an import cancelled while its history is being sent stops before the next batch", async () => {
  S().hydrate({});
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } } });
  stub.historyDbs.clear();
  stub.historyImportRequestBytes.length = 0;
  const cancel = new AbortController();
  const sending = S().importHistory(P, bigHistory(6), cancel.signal);
  cancel.abort();
  const { batches, added } = await sending;
  assert.equal(batches, 1, "only the batch already on its way was sent");
  assert.equal(stub.historyImportRequestBytes.length, 1);
  assert.equal(added, stub.chromeHistory("").size);
  const late = new AbortController();
  late.abort();
  assert.deepEqual(await S().importHistory(P, bigHistory(2), late.signal), { added: 0, batches: 0, failedBatches: 0 });
});

test("an import cancelled while it waits for the profile's bookmarks writes none of them", async () => {
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useBrowser.setState({ bookmarks: { nodes: {} } });
  const root = { type: "folder", title: "Bookmarks", children: [{ type: "folder", title: "Bar", role: "toolbar", children: [{ type: "url", title: "Late", url: "https://late.example/" }] }] };
  const cancel = new AbortController();
  const importing = importBookmarks(P, root, "Chrome", null, undefined, cancel.signal);
  cancel.abort();
  assert.equal(await importing, 0);
  const nodes = Object.values(S().bookmarks.nodes);
  assert.equal(nodes.some((n) => n.url === "https://late.example/"), false);
});
