import assert from "node:assert/strict";
import { test } from "node:test";
import { siteOrigin } from "./siteOrigin.ts";

test("a page address and a stored grant origin reduce to the same scheme, host and non-default port", () => {
  assert.equal(siteOrigin("https://www.Example.com/watch?v=1#t"), "https://www.example.com");
  assert.equal(siteOrigin("https://www.example.com/"), "https://www.example.com");
  assert.equal(siteOrigin("https://meet.example:443/room"), "https://meet.example");
  assert.equal(siteOrigin("http://meet.example:80"), "http://meet.example");
  assert.equal(siteOrigin("https://meet.example:8443/room"), "https://meet.example:8443");
  assert.equal(siteOrigin("http://localhost:8765/"), "http://localhost:8765");
  assert.equal(siteOrigin("https://user:pass@site.example/"), "https://site.example");
  assert.equal(siteOrigin("http://[::1]:3000/x"), "http://[::1]:3000");
  assert.equal(siteOrigin("http://[::1]/x"), "http://[::1]");
});

test("two origins on one host stay apart, and nothing that isn't an address matches", () => {
  assert.notEqual(siteOrigin("https://meet.example/"), siteOrigin("https://meet.example:8443/"));
  assert.notEqual(siteOrigin("http://meet.example/"), siteOrigin("https://meet.example/"));
  for (const nothing of [null, undefined, "", "about:blank", "meet.example", "https:///path"]) assert.equal(siteOrigin(nothing), null);
});
