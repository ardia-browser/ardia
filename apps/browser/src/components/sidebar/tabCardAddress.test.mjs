import assert from "node:assert/strict";
import { test } from "node:test";
const { tabCardAddress } = await import("./tabCardAddress.ts");
const { filePathLabel } = await import("../../lib/url.ts");

const search = "https://www.google.com/search?q=ardia+browser&hl=en";

test("the hover card shows a page's domain by default, without its path or query", () => {
  assert.equal(tabCardAddress(search, false), "google.com");
});

test("with Show full address on, the hover card shows the path and query too", () => {
  assert.equal(tabCardAddress(search, true), "google.com/search?q=ardia+browser&hl=en");
});

test("a page without a host keeps its full address, in both modes", () => {
  assert.equal(tabCardAddress("about:blank", false), tabCardAddress("about:blank", true));
  assert.ok(tabCardAddress("about:blank", false).length > 0);
});

test("a local file shows its short path by default and its whole decoded path with Show full address on", () => {
  const file = "file:///Users/me/projects/ardia/pages/my%20notes.html";
  assert.equal(tabCardAddress(file, false), filePathLabel(file));
  assert.equal(tabCardAddress(file, false), "~/…/pages/my notes.html");
  assert.equal(tabCardAddress(file, true), "/Users/me/projects/ardia/pages/my notes.html");
});

test("a tab without an address shows no address line", () => {
  assert.equal(tabCardAddress("", false), "");
  assert.equal(tabCardAddress("", true), "");
});
