import assert from "node:assert/strict";
import { test } from "node:test";
const { tabCardAddress } = await import("./tabCardAddress.ts");

const search = "https://www.google.com/search?q=ardia+browser&hl=en";

test("the hover card shows a page's domain by default, without its path or query", () => {
  assert.equal(tabCardAddress(search, false), "google.com");
});

test("with Show full address on, the hover card shows the path and query too", () => {
  assert.equal(tabCardAddress(search, true), "google.com/search?q=ardia+browser&hl=en");
});

test("a page without a host keeps its full address, in both modes", () => {
  for (const url of ["file:///Users/me/notes.html", "about:blank"]) {
    assert.equal(tabCardAddress(url, false), tabCardAddress(url, true));
    assert.ok(tabCardAddress(url, false).length > 0, url);
  }
  assert.equal(tabCardAddress("file:///Users/me/notes.html", false), "/Users/me/notes.html");
});

test("a tab without an address shows no address line", () => {
  assert.equal(tabCardAddress("", false), "");
  assert.equal(tabCardAddress("", true), "");
});
