import assert from "node:assert/strict";
import test from "node:test";
import { cardHost, isUnseenReceived, placeholderIndex } from "./tabFace.ts";

test("a card's host is BrowserUrl.host's: no user, port or www., lowercased", () => {
  assert.equal(cardHost("https://user@WWW.Example.com:8080/a?b#c"), "example.com");
  assert.equal(cardHost("https://[::1]:3000/"), "[::1]");
  assert.equal(cardHost("about:blank"), null);
});

test("the placeholder colour is picked by the host's djb2 hash, so every page of a site shares one", () => {
  assert.equal(placeholderIndex("https://example.com/a", 6), placeholderIndex("https://www.example.com/b?c", 6));
  let value = 5381;
  for (const character of "example.com") value = (Math.imul(value, 33) + character.codePointAt(0)!) >>> 0;
  assert.equal(placeholderIndex("https://example.com/", 6), value % 6);
  assert.equal(placeholderIndex("https://example.com/", 0), 0);
});

test("a tab from the Mac wears its badge until it has been opened", () => {
  const sent = { origin: "sent", receivedKey: "k", created: 10, lastActive: 10 };
  assert.equal(isUnseenReceived(sent), true);
  assert.equal(isUnseenReceived({ ...sent, lastActive: 11 }), false);
  assert.equal(isUnseenReceived({ ...sent, receivedKey: null }), false);
  assert.equal(isUnseenReceived({ ...sent, origin: "link" }), false);
});
