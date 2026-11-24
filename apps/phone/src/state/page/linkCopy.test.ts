import { test } from "node:test";
import assert from "node:assert/strict";
import { linkToCopy } from "./linkCopy.ts";

test("a link with trackers is copied without them and says so", () => {
  assert.deepEqual(linkToCopy("https://shop.example/item?id=7&utm_source=mail&fbclid=abc"), { text: "https://shop.example/item?id=7", acknowledgement: "Copied Link Without Trackers" });
});

test("a link with nothing to remove is copied as it is and only says Copied Link", () => {
  assert.deepEqual(linkToCopy("https://shop.example/item?id=7"), { text: "https://shop.example/item?id=7", acknowledgement: "Copied Link" });
  assert.deepEqual(linkToCopy("https://example.com/"), { text: "https://example.com/", acknowledgement: "Copied Link" });
});

test("dropping only an empty query segment is not removing a tracker, so it says plain Copied Link", () => {
  assert.deepEqual(linkToCopy("https://example.com/?q=abc&"), { text: "https://example.com/?q=abc", acknowledgement: "Copied Link" });
  assert.deepEqual(linkToCopy("https://example.com/?&q=abc&&"), { text: "https://example.com/?q=abc", acknowledgement: "Copied Link" });
});

test("a tracker removed alongside an empty segment still says Without Trackers", () => {
  assert.deepEqual(linkToCopy("https://example.com/?q=abc&&utm_source=mail"), { text: "https://example.com/?q=abc", acknowledgement: "Copied Link Without Trackers" });
});
