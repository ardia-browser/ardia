import assert from "node:assert/strict";
import { test } from "node:test";

const { extensionSiteLabel, extensionSitePattern } = await import("./sitePatterns.ts");

test("a typed site becomes a host pattern Chrome grants", () => {
  assert.equal(extensionSitePattern("example.com"), "*://example.com/*");
  assert.equal(extensionSitePattern("  Example.COM  "), "*://example.com/*");
  assert.equal(extensionSitePattern("https://example.com/some/page?q=1#top"), "https://example.com/*");
  assert.equal(extensionSitePattern("http://localhost:8080"), "http://localhost:8080/*");
  assert.equal(extensionSitePattern("*.example.com"), "*://*.example.com/*");
  assert.equal(extensionSitePattern("https://[::1]:3000/x"), "https://[::1]:3000/*");
  assert.equal(extensionSitePattern("bücher.de"), "*://xn--bcher-kva.de/*");
  assert.equal(extensionSitePattern("https://例え.jp/"), "https://xn--r8jz45g.jp/*");
  assert.equal(extensionSitePattern("https://*.example.com"), "https://*.example.com/*");
  assert.equal(extensionSitePattern("https://faß.de/"), "https://xn--fa-hia.de/*");
  assert.equal(extensionSitePattern("https://xn--fa-hia.de/"), "https://xn--fa-hia.de/*");
  assert.equal(extensionSitePattern("FASS.de"), "*://fass.de/*");
});

test("anything Chrome would refuse is refused before it reaches the engine", () => {
  for (const typed of ["", "   ", "ftp://example.com", "chrome://settings", "file:///tmp", "exa mple.com", "https://", "https://exa*mple.com", "example.com:0", "example.com:70000", "javascript:alert(1)", "https://[:::]", "[::]x", "*.com", "https://*.org", "localhost:8080", "https://[1:2]", "https://example.com:99999", "https://exa\u200dmple.com", "a".repeat(3000)])
    assert.equal(extensionSitePattern(typed), null, typed);
});

test("granted patterns show as the site the person typed", () => {
  assert.equal(extensionSiteLabel("*://example.com/*"), "example.com");
  assert.equal(extensionSiteLabel("https://*.example.com/*"), "https://*.example.com");
});
