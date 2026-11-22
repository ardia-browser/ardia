import assert from "node:assert/strict";
import { after, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { applyResult } = await import("./apply.ts");
const { historyOf, MAX_HISTORY } = await import("../history/history.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const client = await import("../telemetry/client.ts");
const { startHistory, reloadHistory } = await import("../history/engineSync.ts");
const { skipInRunningImports } = await import("../history/actions.ts");
const { engineProfile } = await import("../browser/model.ts");
const { historyImportBatches } = await import("../../../../../packages/ardiacore/src/history.ts");

after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const P = "default";

const importResult = (history) => ({ tabs: [], spaces: [], favorites: [], history, credentials: [], favicons: [], bookmarks: null, vaultToken: null });

const zenSizedHistory = (count, title = (i) => `Article ${i}: a page title about as long as the ones browsers keep`) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://site${i % 900}.example/articles/${i}/a-readable-slug-for-page-${i}?utm_source=newsletter&utm_medium=email&ref=${i}`,
    title: title(i),
    visits: 1 + (i % 5),
    lastVisit: 1_700_000_000_000 + i,
  }));

function freshImport() {
  S().hydrate({});
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } } });
  stub.historyDbs.clear();
  stub.historyImportRequestBytes.length = 0;
  stub.refusedHistoryImports.next = 0;
  stub.heldHistoryImports.reply = null;
  stub.heldHistoryQueries.reply = null;
  takeImportRuns();
  client.setSharing(true, "onboarding");
  return client.consentToken();
}

test("a Zen-sized history import reaches the engine in requests under its 8 MiB limit, and the summary counts what landed", async () => {
  const consent = freshImport();
  const rows = zenSizedHistory(66_930);
  const failed = [];
  const counts = await applyResult(P, importResult(rows), "Zen", ["history"], (kind) => failed.push(kind), consent);
  assert.deepEqual(failed, []);
  assert.equal(stub.chromeHistory("").size, rows.length, "every page is in the engine's history");
  assert.equal(counts.history, rows.length);
  assert.ok(stub.historyImportRequestBytes.length > 1, "split into several requests");
  assert.ok(stub.historyImportRequestBytes.every((bytes) => bytes <= stub.ENGINE_REQUEST_LIMIT_BYTES));
  const sent = takeImportRuns();
  assert.equal(sent.import_history_batches, stub.historyImportRequestBytes.length);
  assert.equal(sent.import_history_batches_failed, 0);
});

test("history titles in a non-Latin script still fit the engine's limit, which counts UTF-8 bytes", async () => {
  const consent = freshImport();
  const rows = zenSizedHistory(20_000, (i) => `${i} ${"履歴の記事".repeat(60)}`);
  const failed = [];
  const counts = await applyResult(P, importResult(rows), "Zen", ["history"], (kind) => failed.push(kind), consent);
  assert.deepEqual(failed, []);
  assert.equal(counts.history, rows.length);
  assert.ok(stub.historyImportRequestBytes.every((bytes) => bytes <= stub.ENGINE_REQUEST_LIMIT_BYTES));
});

test("when the engine refuses part of a history import, History is reported failed and only the pages that landed are counted or listed", async () => {
  const consent = freshImport();
  stub.refusedHistoryImports.next = 1;
  const rows = zenSizedHistory(66_930);
  const failed = [];
  const counts = await applyResult(P, importResult(rows), "Zen", ["history"], (kind) => failed.push(kind), consent);
  assert.deepEqual(failed, ["history"]);
  const landed = stub.chromeHistory("").size;
  assert.ok(landed > 0 && landed < rows.length, "the other requests still landed");
  assert.equal(counts.history, landed);
  assert.equal(historyOf(S(), P).length, landed, "the history list shows only what the engine kept");
  const sent = takeImportRuns();
  assert.equal(sent.import_history_batches_failed, 1);
});

function holdEngineReplies() {
  let release;
  stub.heldHistoryImports.reply = new Promise((resolve) => (release = resolve));
  return () => {
    stub.heldHistoryImports.reply = null;
    release();
  };
}

test("a page deleted while its import is still finishing stays deleted", async () => {
  const consent = freshImport();
  const release = holdEngineReplies();
  const rows = zenSizedHistory(3);
  const importing = applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
  await new Promise((r) => setTimeout(r, 5));
  S().removeHistory(P, [rows[0].url]);
  release();
  const counts = await importing;
  assert.equal(stub.chromeHistory("").has(rows[0].url), false);
  assert.equal(historyOf(S(), P).some((h) => h.url === rows[0].url), false, "not brought back into the list");
  assert.equal(counts.history, rows.length);
});

test("a history reload while an import is finishing doesn't lower the count of pages it added", async () => {
  const consent = freshImport();
  const stop = startHistory();
  const rows = zenSizedHistory(20_000);
  let counts;
  try {
    await reloadHistory();
    const release = holdEngineReplies();
    const importing = applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
    await new Promise((r) => setTimeout(r, 5));
    await reloadHistory();
    release();
    counts = await importing;
  } finally {
    stop();
  }
  assert.equal(stub.chromeHistory("").size, rows.length);
  assert.equal(counts.history, rows.length);
  assert.equal(historyOf(S(), P).length, rows.length, "the list shows every page");
});

test("history import batches split at the character budget and give an oversized row a batch of its own", () => {
  const row = (url, title = "") => ({ url, title, visits: 1, lastVisit: 1 });
  const wireSize = (r) => JSON.stringify({ u: r.url, t: r.title, n: r.visits, l: r.lastVisit }).length + 1;
  assert.deepEqual(historyImportBatches([]), []);
  const small = [row("https://a.example/"), row("https://b.example/"), row("https://c.example/")];
  const budget = wireSize(small[0]) * 2;
  assert.deepEqual(historyImportBatches(small, budget).map((b) => b.length), [2, 1], "two fit exactly, the third starts a new batch");
  const huge = row("https://huge.example/", "x".repeat(budget * 3));
  assert.deepEqual(historyImportBatches([small[0], huge, small[1]], budget).map((b) => b.map((r) => r.url)), [["https://a.example/"], ["https://huge.example/"], ["https://b.example/"]]);
});

test("pages without a last visit aren't counted or listed, since the engine drops them", async () => {
  const consent = freshImport();
  const rows = [...zenSizedHistory(2), { url: "https://undated.example/", title: "Undated", visits: 1, lastVisit: 0 }];
  const counts = await applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
  assert.equal(counts.history, 2);
  assert.equal(historyOf(S(), P).some((h) => h.url === "https://undated.example/"), false);
});

test("pages deleted or cleared while earlier batches are still saving are left out of the later ones", async () => {
  const consent = freshImport();
  const stop = startHistory();
  const rows = zenSizedHistory(30_000);
  const [deleted, cleared] = [rows.at(-1), rows.at(-2)];
  let counts;
  try {
    await reloadHistory();
    const release = holdEngineReplies();
    const importing = applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stub.historyImportRequestBytes.length, 1, "only the first batch has gone out");
    S().removeHistory(P, [deleted.url]);
    S().clearHistory(P, cleared.lastVisit, cleared.lastVisit);
    release();
    counts = await importing;
    await reloadHistory();
  } finally {
    stop();
  }
  assert.ok(stub.historyImportRequestBytes.length > 2, "several batches");
  assert.equal(stub.chromeHistory("").has(deleted.url), false);
  assert.equal(stub.chromeHistory("").has(cleared.url), false);
  const listed = new Set(historyOf(S(), P).map((h) => h.url));
  assert.equal(listed.has(deleted.url) || listed.has(cleared.url), false, "a reload doesn't bring them back");
  assert.equal(counts.history, rows.length - 2);
});

test("a refused import into a full history list puts back the older pages it pushed off the end", async () => {
  const consent = freshImport();
  const full = Array.from({ length: MAX_HISTORY }, (_, i) => ({ url: `https://old${i}.example/`, title: "", favicon: null, visits: 1, lastVisit: 1000 + MAX_HISTORY - i }));
  useBrowser.setState({ history: { "": { list: full, floor: -Infinity, ready: true } } });
  stub.refusedHistoryImports.next = 1;
  const failed = [];
  const counts = await applyResult(P, importResult(zenSizedHistory(3)), "Zen", ["history"], (kind) => failed.push(kind), consent);
  assert.deepEqual(failed, ["history"]);
  assert.equal(counts.history, 0);
  const list = historyOf(S(), P);
  assert.equal(list.length, MAX_HISTORY);
  assert.equal(list.at(-1).url, full.at(-1).url, "the oldest page is back");
});

test("a refused import into a full list puts the older pages back even when its own pages were deleted meanwhile", async () => {
  const consent = freshImport();
  const full = Array.from({ length: MAX_HISTORY }, (_, i) => ({ url: `https://old${i}.example/`, title: "", favicon: null, visits: 1, lastVisit: 1000 + MAX_HISTORY - i }));
  useBrowser.setState({ history: { "": { list: full, floor: -Infinity, ready: true } } });
  stub.refusedHistoryImports.next = 1;
  const [incoming] = zenSizedHistory(1);
  const importing = applyResult(P, importResult([incoming]), "Zen", ["history"], () => {}, consent);
  S().removeHistory(P, [incoming.url]);
  const counts = await importing;
  assert.equal(counts.history, 0);
  const list = historyOf(S(), P);
  assert.equal(list.length, MAX_HISTORY);
  assert.equal(list.at(-1).url, full.at(-1).url, "the oldest page is back");
});

test("an import into a profile created a moment ago lists every page, though its first history load overlapped the batches", async () => {
  const consent = freshImport();
  const stop = startHistory();
  const rows = zenSizedHistory(30_000);
  let dest, counts;
  try {
    await reloadHistory();
    dest = S().createProfile({ name: "Imported" });
    counts = await applyResult(dest, importResult(rows), "Zen", ["history"], () => {}, consent);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    stop();
  }
  assert.ok(stub.historyImportRequestBytes.length > 1, "several batches");
  assert.equal(stub.chromeHistory(engineProfile(S(), dest)).size, rows.length);
  assert.equal(counts.history, rows.length);
  assert.equal(historyOf(S(), dest).length, rows.length);
});

test("Clear Browsing Data while an import is saving keeps the cleared range out of the batches still to go", async () => {
  const consent = freshImport();
  const release = holdEngineReplies();
  const rows = zenSizedHistory(30_000);
  const importing = applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
  await new Promise((r) => setTimeout(r, 5));
  const firstBatch = stub.chromeHistory("").size;
  skipInRunningImports("", undefined, Date.now());
  stub.chromeHistory("").clear();
  release();
  const counts = await importing;
  assert.ok(firstBatch > 0 && firstBatch < rows.length);
  assert.equal(stub.chromeHistory("").size, 0, "no later batch writes a cleared page back");
  assert.equal(counts.history, firstBatch);
});

test("a new profile's first history read that comes back after the import doesn't cut the list down to its older snapshot", async () => {
  const consent = freshImport();
  const stop = startHistory();
  const rows = zenSizedHistory(30_000);
  let dest, counts;
  try {
    await reloadHistory();
    let releaseQueries;
    stub.heldHistoryQueries.reply = new Promise((resolve) => (releaseQueries = resolve));
    dest = S().createProfile({ name: "Imported" });
    await new Promise((r) => setTimeout(r, 5));
    counts = await applyResult(dest, importResult(rows), "Zen", ["history"], () => {}, consent);
    stub.heldHistoryQueries.reply = null;
    releaseQueries();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    stub.heldHistoryQueries.reply = null;
    stop();
  }
  assert.equal(counts.history, rows.length);
  assert.equal(historyOf(S(), dest).length, rows.length);
});

test("a new profile's first history read that lands at any moment around the end of the import leaves every page listed", async () => {
  for (const microtasks of [0, 3, 8, 15, 25, 40, 80]) {
    const consent = freshImport();
    const stop = startHistory();
    const rows = zenSizedHistory(30_000);
    let dest;
    try {
      await reloadHistory();
      let releaseQueries;
      stub.heldHistoryQueries.reply = new Promise((resolve) => (releaseQueries = resolve));
      dest = S().createProfile({ name: "Imported" });
      await new Promise((r) => setTimeout(r, 5));
      stub.heldHistoryQueries.reply = null;
      const releaseImports = holdEngineReplies();
      const importing = applyResult(dest, importResult(rows), "Zen", ["history"], () => {}, consent);
      await new Promise((r) => setTimeout(r, 5));
      releaseImports();
      for (let i = 0; i < microtasks; i++) await null;
      releaseQueries();
      await importing;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      stub.heldHistoryQueries.reply = null;
      stop();
    }
    assert.equal(historyOf(S(), dest).length, rows.length, `query released ${microtasks} microtasks after the import replies`);
  }
});

test("a Clear Browsing Data that fails stops keeping its range out of the batches still to go", async () => {
  const consent = freshImport();
  const release = holdEngineReplies();
  const rows = zenSizedHistory(30_000);
  const importing = applyResult(P, importResult(rows), "Zen", ["history"], () => {}, consent);
  await new Promise((r) => setTimeout(r, 5));
  const importAgain = skipInRunningImports("", undefined, Date.now());
  importAgain();
  release();
  const counts = await importing;
  assert.equal(stub.chromeHistory("").size, rows.length);
  assert.equal(counts.history, rows.length);
});
