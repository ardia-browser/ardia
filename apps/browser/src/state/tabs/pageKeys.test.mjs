import assert from "node:assert/strict";
import { test } from "node:test";
const { pageKey } = await import("./pageKeys.ts");

test("a line break or tab inside an address is dropped, as the URL parser does, and never throws", () => {
  assert.equal(pageKey("https://exa\nmple.example/"), "https://example.example/");
  assert.equal(pageKey("https://Example.example:0\r\n443/pa\tth"), "https://example.example/path");
  assert.equal(pageKey("https://\n/"), "https:///");
  assert.doesNotThrow(() => pageKey("https://a\n:b\n@c\n:\n/"));
});

test("an address without a scheme and authority stays as it is", () => {
  assert.equal(pageKey("about:blank"), "about:blank");
  assert.equal(pageKey("not a url"), "not a url");
});
