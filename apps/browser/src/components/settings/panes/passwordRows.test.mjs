import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../../test-native/ardiacore.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { usePasswordUnlocks } = await import("../../../state/site/savedPasswords.ts");
const { noteSettingsScroll, ROW_PAGE, useGrowingRows } = await import("../../../state/settings/growingRows.ts");
const { PANE_PAGE } = await import("../../../state/vaults/paneRows.ts");
const { listWindow, OVERSCAN_ROWS, recycledKeys } = await import("../WindowedRows.tsx");
const { PasswordList } = await import("./PasswordList.tsx");
const { takeExportCounts } = await import("../../../state/telemetry/exportCounts.ts");
const { PasswordsPage } = await import("./ProfilePasswords.tsx");

const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));

function find(node, match) {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = find(n, match);
      if (found) return found;
    }
  } else if (node && typeof node === "object" && "props" in node) {
    if (match(node)) return node;
    return find(node.props.children, match) ?? find(node.props.action, match);
  }
  return null;
}

const listOf = (page) => find(page.value, (n) => n.type === PasswordList)?.props.rows;
const searchOf = (page) => find(page.value, (n) => typeof n.props?.onSearch === "function")?.props;

function savedLogins(n) {
  const store = new Map();
  for (let i = 0; i < n; i++) store.set(`k${i}`, { origin: `https://site${i}.test`, url: `https://site${i}.test`, username: `user${i}`, password: "pw", created: i });
  native.passwordStores.set(native.current.device, store);
}

async function openPasswords(n) {
  S().hydrate({});
  S().createWindow({ url: "https://a.com/" });
  savedLogins(n);
  native.vaultFakes.paneAsks.length = 0;
  usePasswordUnlocks.setState({ unlocked: { "": true } });
  const page = mount(() => PasswordsPage({ profileId: S().settings.defaultProfileId }));
  for (let i = 0; i < 4; i++) await flush();
  return page;
}

test("unlocking 50,000 saved passwords asks the native list for one page of rows, never the whole list", async () => {
  takeExportCounts();
  const page = await openPasswords(50_000);
  const rows = listOf(page);
  assert.equal(rows.total, 50_000);
  assert.equal(rows.listed, 50_000);
  assert.ok(rows.rowAt(0)?.saved, "the first row arrived");
  assert.equal(rows.rowAt(PANE_PAGE), undefined, "a row past the first page isn't fetched until it's wanted");
  assert.deepEqual(native.vaultFakes.paneAsks.map((a) => [a.offset, a.limit, a.reload]), [[0, PANE_PAGE, true]], "one page, and the profile's list is read again");
  const counts = takeExportCounts();
  assert.equal(counts.password_list_shows, 1);
  assert.equal(counts.password_list_large_shows, 1);
});

test("scrolling asks only for the pages it reaches, each at most one page long", async () => {
  const page = await openPasswords(50_000);
  listOf(page).want(30_050, 30_120);
  for (let i = 0; i < 3; i++) await flush();
  assert.deepEqual(native.vaultFakes.paneAsks.slice(1).map((a) => [a.offset, a.limit, a.reload]), [[30_000, PANE_PAGE, false], [30_100, PANE_PAGE, false]]);
  assert.ok(listOf(page).rowAt(30_120)?.saved);
  assert.ok(native.vaultFakes.paneAsks.every((a) => a.limit <= PANE_PAGE));
});

test("a search goes to the native list and counts as a search once its rows are shown", async () => {
  const page = await openPasswords(5000);
  takeExportCounts();
  const search = searchOf(page);
  search.onTyped("site42");
  search.onSearch("site42");
  page.rerender();
  for (let i = 0; i < 4; i++) await flush();
  const rows = listOf(page);
  assert.equal(native.vaultFakes.paneAsks.at(-1).query, "site42");
  assert.equal(rows.total, 111);
  assert.equal(rows.listed, 5000);
  assert.equal(takeExportCounts().password_list_searches, 1);
});

test("the shown window covers the viewport plus a little on each side, wherever the list starts", () => {
  const pitch = 45;
  const atTop = listWindow(0, 800, 0, pitch, 50_000);
  assert.equal(atTop.first, 0);
  assert.ok(atTop.last >= Math.ceil(800 / pitch) && atTop.last <= Math.ceil(800 / pitch) + OVERSCAN_ROWS + 10);
  const deep = listWindow(1_000_000, 800, 1000, pitch, 50_000);
  assert.ok(deep.first * pitch <= 1_000_000 - 1000 && deep.last * pitch >= 1_000_000 - 1000 + 800);
  assert.ok(deep.last - deep.first < 80, "a window stays small however long the list is");
  assert.deepEqual(listWindow(0, 800, 5_000, pitch, 50_000), { first: 0, last: 0 }, "a list below the fold renders one row");
  assert.deepEqual(listWindow(0, 800, 0, pitch, 0), { first: 0, last: -1 });
});

test("rows that leave the window hand their keys to rows that enter it", () => {
  const first = recycledKeys({ byIndex: new Map(), next: 0 }, 0, 9);
  assert.deepEqual([...first.byIndex.values()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const moved = recycledKeys(first, 4, 13);
  assert.equal(moved.next, 10, "no new keys while the window keeps its size");
  for (let i = 4; i <= 9; i++) assert.equal(moved.byIndex.get(i), first.byIndex.get(i), "rows still shown keep their keys");
});

test("after a search shrinks the list back to a height it had before, scrolling to its end still adds a page", () => {
  const rows = mount((p) => useGrowingRows(5000, p.query), { props: { query: "" } });
  assert.equal(rows.value, ROW_PAGE);
  noteSettingsScroll(29_000, 800, 30_000);
  assert.equal(rows.value, 2 * ROW_PAGE);
  noteSettingsScroll(0, 800, 50_000);
  rows.rerender({ query: " " });
  assert.equal(rows.value, ROW_PAGE, "a new search starts from one page");
  noteSettingsScroll(29_000, 800, 30_000);
  assert.equal(rows.value, 2 * ROW_PAGE, "the same end height as before grows the list again");
});

test("staying at the end adds one page, and leaving the end and coming back adds the next", () => {
  const rows = mount((p) => useGrowingRows(5000, p.query), { props: { query: "x" } });
  noteSettingsScroll(39_000, 800, 40_000);
  noteSettingsScroll(39_100, 800, 40_000);
  assert.equal(rows.value, 2 * ROW_PAGE);
  noteSettingsScroll(10_000, 800, 40_000);
  noteSettingsScroll(39_200, 800, 40_000);
  assert.equal(rows.value, 3 * ROW_PAGE);
});
