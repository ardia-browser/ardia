import assert from "node:assert/strict";
import { test } from "node:test";
import { anonIdentity } from "./anonIdentity.ts";

const ID = "4f2a91c3-8b1d-4e5f-9a0b-1c2d3e4f5a6b";

test("the same install always gets the same name, art, serial and rarity", () => {
  assert.deepEqual(anonIdentity(ID), anonIdentity(ID));
});

test("the serial is the install's first eight hex digits, grouped", () => {
  assert.equal(anonIdentity(ID).serial, "4F2A·91C3");
});

test("names are an adjective and a creature, with rarity from one to three", () => {
  const names = new Set();
  for (let i = 0; i < 200; i++) {
    const me = anonIdentity(`${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    assert.match(me.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.ok(me.rarity >= 1 && me.rarity <= 3);
    names.add(me.name);
  }
  assert.ok(names.size > 100, `names repeat too often: ${names.size} distinct of 200`);
});
