import assert from "node:assert/strict";
import { test } from "node:test";
import { steadyRows } from "./steadyRows.ts";

const page = { url: "https://example.com/" };
const search = { url: "search:example.com" };
const late = { url: "search:example.com email" };
const history = { url: "https://example.org/" };
const list = (items, completion = "") => ({ items, completion });
const rowKey = (row) => row.url;
const step = (shown, items, key, holding, completion) => steadyRows(shown, list(items, completion), key, holding, rowKey);

test("rows that arrive while the pointer is over the list or Go wait, so Go stays under the pointer", () => {
  const shown = step(null, [page, search], "example.com", false);
  assert.deepEqual(step(shown, [page, search, late], "example.com", true).value.items, [page, search]);
});

test("rows replaced at the same length wait too, so the row under the pointer stays", () => {
  const shown = step(null, [page, search, history], "example.com", false);
  assert.deepEqual(step(shown, [page, search, late], "example.com", true).value.items, [page, search, history]);
});

test("the completion waits with its rows, so the field and Go say the same thing", () => {
  const shown = step(null, [search], "exa", false);
  assert.deepEqual(step(shown, [page, search], "exa", true, "mple.com").value, list([search]));
});

test("the same rows with new contents show at once", () => {
  const shown = step(null, [page, search], "exa", false);
  assert.deepEqual(step(shown, [page, search], "exa", true, "mple.com").value.completion, "mple.com");
});

test("the waiting rows show once the pointer leaves", () => {
  const held = step(step(null, [page, search], "example.com", true), [page, search, late], "example.com", true);
  assert.deepEqual(step(held, [page, search, late], "example.com", false).value.items, [page, search, late]);
});

test("new text always shows its own rows, pointer or not", () => {
  const shown = step(null, [page, search], "example.co", true);
  assert.deepEqual(step(shown, [page, search, late], "example.com", true).value.items, [page, search, late]);
});

test("an empty list is never held, so the first rows show under a resting pointer", () => {
  assert.deepEqual(step(step(null, [], "e", true), [page], "e", true).value.items, [page]);
});

test("late rows keep waiting while the pointer moves from the list onto Go, so Go never moves under it", () => {
  const typed = step(null, [page, search], "example.com", false);
  const overList = step(typed, [page, search, late], "example.com", true);
  const later = { url: "search:example.com login" };
  const overGo = step(overList, [page, search, late, later], "example.com", true);
  assert.deepEqual(overList.value.items, [page, search]);
  assert.deepEqual(overGo.value.items, [page, search]);
  assert.deepEqual(step(overGo, [page, search, late, later], "example.com", false).value.items, [page, search, late, later]);
});
