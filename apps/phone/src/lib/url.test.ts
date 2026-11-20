import assert from "node:assert/strict";
import test from "node:test";
import { dedupeByLanding, displayHost, landingKey } from "./url.ts";

test("a page suggestion's detail is its host, as SearchInput.displayHost and BrowserUrl.displayHost show it", () => {
  assert.equal(displayHost("www.google.com", "https://www.google.com/search?q=otters%20cafe&sei=Mq"), "google.com");
  assert.equal(displayHost("en.wikipedia.org", "https://en.wikipedia.org/wiki/Otter"), "en.wikipedia.org");
  assert.equal(displayHost("", "about:blank"), "about:blank");
});

test("pages that land on the same address are one suggestion, the open tab's row winning", () => {
  assert.equal(landingKey("https://Example.com/"), landingKey("http://example.com"));
  assert.equal(landingKey("https://example.com/a/?q=1#top"), "example.com/a?q=1");
  assert.notEqual(landingKey("https://example.com/a"), landingKey("https://example.com/b"));
  const rows = [
    { url: "http://example.com/", opensTab: false, id: 1 },
    { url: "https://example.com", opensTab: true, id: 2 },
    { url: "https://example.org/", opensTab: false, id: 3 },
    { url: "https://example.com/#more", opensTab: false, id: 4 },
  ];
  assert.deepEqual(dedupeByLanding(rows).map((row) => row.id), [2, 3]);
});

test("a row's host drops the port, as main's BrowserURL.host does, an IPv6 address kept whole", () => {
  assert.equal(displayHost("127.0.0.1:8777", "http://127.0.0.1:8777/still.html"), "127.0.0.1");
  assert.equal(displayHost("www.example.com:8443", "https://www.example.com:8443/"), "example.com");
  assert.equal(displayHost("[::1]", "http://[::1]/"), "[::1]");
  assert.equal(displayHost("[::1]:8080", "http://[::1]:8080/"), "[::1]");
});
