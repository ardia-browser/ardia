import assert from "node:assert/strict";
import { test } from "node:test";
const { isFields, ownValue } = await import("./decode.ts");

test("fields are any non-null, non-list object, class instances included", () => {
  assert.equal(isFields({}), true);
  assert.equal(isFields(new Date(0)), true);
  assert.equal(isFields(Object.create(null)), true);
  for (const value of [null, undefined, [], "x", 1, true]) assert.equal(isFields(value), false, String(value));
});

test("an own value is read only for a string key the record itself holds", () => {
  const record = { a: 1, zero: 0 };
  assert.equal(ownValue(record, "a"), 1);
  assert.equal(ownValue(record, "zero"), 0);
  assert.equal(ownValue(record, "missing"), undefined);
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(ownValue(record, key), undefined, key);
  for (const key of [1, null, undefined, {}, ["a"]]) assert.equal(ownValue(record, key), undefined, String(key));
  assert.equal(ownValue(undefined, "a"), undefined);
  const bare = Object.assign(Object.create(null), { k: "v" });
  assert.equal(ownValue(bare, "k"), "v");
});
