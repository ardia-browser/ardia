import assert from "node:assert/strict";
import { test } from "node:test";
const { coversHost, hiddenElementTitle, hidingFilter, hidingHost, parseHidingFilter, savablePickedSelector } = await import("./hiddenElements.ts");
const { pickerCall } = await import("./elementPicker.ts");

test("a page's hiding host is its http(s) hostname without www.", () => {
  assert.equal(hidingHost("https://www.example.com/a?b"), "example.com");
  assert.equal(hidingHost("http://news.Example.com:8080/"), "news.example.com");
  assert.equal(hidingHost("https://xn--bcher-kva.example/"), "xn--bcher-kva.example");
  assert.equal(hidingHost("file:///Users/me/a.html"), null);
  assert.equal(hidingHost("ardia://settings"), null);
  assert.equal(hidingHost("http://[::1]/"), null);
  assert.equal(hidingHost(""), null);
});

test("a hiding filter is uBlock Origin's host##selector, and nothing else gets through", () => {
  assert.equal(hidingFilter("example.com", "#banner"), "example.com###banner");
  assert.equal(hidingFilter("example.com", "div.ad > span:nth-of-type(2)"), "example.com##div.ad > span:nth-of-type(2)");
  assert.equal(hidingFilter("example.com", "+js(nowebrtc)"), null);
  assert.equal(hidingFilter("example.com", "^script"), null);
  assert.equal(hidingFilter("example.com", "div { color: red }"), null);
  assert.equal(hidingFilter("example.com", "div\nexample.org##p"), null);
  assert.equal(hidingFilter("example.com", ""), null);
  assert.equal(hidingFilter("example.com", "a".repeat(2000)), null);
});

test("a selector that a page's fake picker smuggles past the line break can't become a scriptlet filter", () => {
  const CR = String.fromCharCode(13);
  const [open, close] = ["/" + "*", "*" + "/"];
  const smuggled = `head${open}${CR}*##+js(trusted-create-html, body, <img hidden src=x onerror="alert(document.cookie)">)${CR}${close}`;
  assert.equal(hidingFilter("evil.example", smuggled), null);
  assert.equal(parseHidingFilter(`evil.example##${smuggled}`), null);
  for (const breaker of [0, 9, 10, 11, 12, 13, 0x1f, 0x7f, 0x85, 0x2028, 0x2029])
    assert.equal(hidingFilter("example.com", `div${String.fromCharCode(breaker)}p`), null, `U+${breaker.toString(16)}`);
  assert.equal(hidingFilter("example.com", `head${open} x ${close}`), null);
  assert.equal(hidingFilter("example.com", 'a[data-testid="promo card"]'), 'example.com##a[data-testid="promo card"]');
});

test("a picked test id with characters a rule can't hold saves them as CSS escapes, and a line break is never saved", () => {
  const ch = (code) => String.fromCharCode(code);
  const opener = "/" + "*";
  const saved = (selector) => hidingFilter("example.com", savablePickedSelector(selector) ?? "");
  assert.equal(savablePickedSelector('section[data-testid="promo"]'), 'section[data-testid="promo"]');
  assert.equal(savablePickedSelector(`section[data-testid="promo${opener}card"]`), 'section[data-testid="promo/\\2a card"]');
  assert.equal(savablePickedSelector(`div > a[data-qa="a${ch(9)}b"]`), 'div > a[data-qa="a\\9 b"]');
  for (const code of [1, 9, 11, 0x1f, 0x7f, 0x85, 0x2028, 0x2029])
    assert.ok(saved(`section[data-testid="a${ch(code)}b"]`), `U+${code.toString(16)} inside a test id saves`);
  for (const code of [10, 12, 13]) {
    assert.equal(savablePickedSelector(`section[data-testid="a${ch(code)}b"]`), null, `U+${code.toString(16)} is a line break`);
    assert.equal(savablePickedSelector(`section[data-testid="a"]${ch(code)}example.org##+js(x)`), null);
  }
  assert.equal(saved(`section[data-testid="a${ch(0)}b"]`), null, "NUL has no CSS escape that means itself");
  assert.equal(saved(`section[title="a${ch(0x2028)}b"]`), null, "only the picker's own test-id attributes are rewritten");
  assert.equal(saved(`section${ch(0x85)}[data-testid="a"]`), null, "nothing outside the test id is rewritten");
  assert.equal(saved(`head${opener} x *\/`), null);
});

test("a filter parses back to its host and selector, and other user filters don't", () => {
  assert.deepEqual(parseHidingFilter("example.com###banner"), { filter: "example.com###banner", host: "example.com", selector: "#banner", session: false });
  assert.equal(parseHidingFilter("||ads.example.com^"), null);
  assert.equal(parseHidingFilter("example.com#@#.ad"), null);
  assert.equal(parseHidingFilter("! a comment"), null);
  assert.equal(parseHidingFilter("example.com##+js(set, a, 1)"), null);
});

test("a rule covers its host and that host's subdomains, as uBlock Origin applies it", () => {
  assert.ok(coversHost("example.com", "example.com"));
  assert.ok(coversHost("example.com", "news.example.com"));
  assert.ok(!coversHost("example.com", "badexample.com"));
  assert.ok(!coversHost("news.example.com", "example.com"));
});

test("a hidden element's title is the last step of its selector", () => {
  assert.equal(hiddenElementTitle("#banner"), "#banner");
  assert.equal(hiddenElementTitle("main > div.promo > aside:nth-of-type(2)"), "aside #2");
  assert.equal(hiddenElementTitle("div.sc\\:x"), "div.sc:x");
});

test("every picker call is a script the page can run", () => {
  for (const call of [pickerCall("start", [10, 20]), pickerCall("start", null), pickerCall("cancel"), pickerCall("apply", ["#a"]), pickerCall("unhide", ["#a"])])
    assert.doesNotThrow(() => new Function("post", call));
});
