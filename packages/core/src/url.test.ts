import assert from "node:assert/strict";
import { test } from "node:test";
import { PSL_TLDS } from "./tlds.ts";
import { domainToASCII } from "node:url";
import { cleanLinkTitle, cleanUrl, cleanUrlReport, linkLines, markdownLink } from "./cleanUrl.ts";
import { displayHost, hostSpoofReason, punycodeEncode } from "./idn.ts";
import { breadcrumb, classifyPaste, fixupUrl, intranetLinkHost, intranetUrl, resolveInput, sameAddress, spacedAddressGuess, urlForDisplay } from "./omnibox.ts";
import { displayUrl } from "./suggest.ts";

const GOOGLE = "https://www.google.com/search?q=";

test("resolveInput turns typed text into a URL", () => {
  assert.equal(resolveInput("apple.com", GOOGLE), "https://apple.com");
  assert.equal(resolveInput("localhost:3000", GOOGLE), "http://localhost:3000");
  assert.equal(resolveInput("192.168.1.1/admin", GOOGLE), "http://192.168.1.1/admin");
  assert.equal(resolveInput("https://x.com/home", GOOGLE), "https://x.com/home");
  assert.equal(resolveInput("about:blank", GOOGLE), "about:blank");
  assert.equal(resolveInput("how to cook rice", GOOGLE), "https://www.google.com/search?q=how%20to%20cook%20rice");
  assert.equal(resolveInput("react", GOOGLE), "https://www.google.com/search?q=react");
  assert.equal(resolveInput("   ", GOOGLE), "");
});

test("fixupUrl: ports, IPv6, local names, schemes and file paths", () => {
  assert.equal(fixupUrl("example.com:8080/x"), "https://example.com:8080/x");
  assert.equal(fixupUrl("[::1]:8080"), "http://[::1]:8080");
  assert.equal(fixupUrl("printer.local"), "http://printer.local");
  assert.equal(fixupUrl("myapp.localhost:5173"), "http://myapp.localhost:5173");
  assert.equal(fixupUrl("HTTPS://Example.com/Path"), "https://Example.com/Path");
  assert.equal(fixupUrl("file:///Users/me/a.html"), "file:///Users/me/a.html");
  assert.equal(fixupUrl("/Users/me/My File.html"), "file:///Users/me/My%20File.html");
  assert.equal(fixupUrl("mailto:hi@example.com"), "mailto:hi@example.com");
  assert.equal(fixupUrl("xn--bcher-kva.example"), null);
  assert.equal(fixupUrl("bücher.de"), "https://bücher.de");
  assert.equal(fixupUrl("en.wikipedia.org/wiki/Cat"), "https://en.wikipedia.org/wiki/Cat");
  assert.equal(fixupUrl("github.io"), "https://github.io");
  assert.equal(fixupUrl("example.co.uk"), "https://example.co.uk");
});

test("fixupUrl leaves searches alone: file names, emails, prose, unknown schemes", () => {
  for (const text of ["index.html", "node.js", "hi@example.com", "what is apple.com", "note: buy milk", "c++", "javascript:alert(1)", "1.5", "e.g."]) {
    assert.equal(fixupUrl(text), null, text);
  }
  assert.equal(fixupUrl("docs.internal/setup"), "http://docs.internal/setup");
  assert.equal(fixupUrl("site.photography/about"), "https://site.photography/about");
});

test("four numbers are an IPv4 address only up to 255 each, as in Chrome: past that they search", () => {
  for (const input of ["192.168.0.256", "256.1.1.1", "10.256.0.1", "10.0.256.1", "999.999.999.999", "192.168.0.256.", "192.168.0.256:8080", "10.0.0.300/admin", "192.168.0.256/a b"]) {
    assert.equal(fixupUrl(input), null, input);
    assert.equal(classifyPaste(input)?.kind, "search", input);
    assert.equal(spacedAddressGuess(input), null, input);
  }
  for (const input of ["192.168.0.1.", "192.168.0.255", "255.255.255.255", "0.0.0.0", "10.0.0.30/admin", "192.168.0.1:8080"]) {
    assert.equal(fixupUrl(input), `http://${input}`, input);
  }
  assert.equal(fixupUrl("http://192.168.0.256"), "http://192.168.0.256", "a typed scheme still opens");
});

test("fixupUrl opens an address with a space after its host, as Chrome does, and leaves prose with a slash alone", () => {
  assert.equal(fixupUrl("en.wikipedia.org/wiki/Jim Beam"), "https://en.wikipedia.org/wiki/Jim%20Beam");
  assert.equal(fixupUrl("github.com/search?q=a b"), "https://github.com/search?q=a%20b");
  assert.equal(fixupUrl("localhost:3000/a b"), "http://localhost:3000/a%20b");
  for (const text of ["AC/DC songs", "AC/DC greatest hits #1", "C# nullable ? operator", "km/h to mph", "24/7 pharmacy near me", "r/macapps best apps", "x.com cats", "example.com /a", "foo bar/baz", "sms:123?what time"]) {
    assert.equal(fixupUrl(text), null, text);
  }
  assert.deepEqual(classifyPaste("en.wikipedia.org/wiki/Jim Beam"), { kind: "go", url: "https://en.wikipedia.org/wiki/Jim%20Beam" });
  assert.deepEqual(classifyPaste("AC/DC songs"), { kind: "search", query: "AC/DC songs" });
  assert.deepEqual(classifyPaste("example.com/a\nb"), { kind: "search", query: "example.com/a b" });
  assert.deepEqual(classifyPaste("https://a b.com/x"), { kind: "search", query: "https://a b.com/x" });
});

test("a spaced address opens only when it can't be prose: a wiki path, a named query key, a port, localhost or an IP", () => {
  const opens = {
    "en.wikipedia.org/wiki/Jim Beam": "https://en.wikipedia.org/wiki/Jim%20Beam",
    "github.com/search?q=a b": "https://github.com/search?q=a%20b",
    "localhost:3000/a b": "http://localhost:3000/a%20b",
    "[::1]:8080/a b": "http://[::1]:8080/a%20b",
    "devbox:8080/a b": "http://devbox:8080/a%20b",
    "localhost./a b": "http://localhost./a%20b",
    "192.168.1.2/a b": "http://192.168.1.2/a%20b",
    "de.wikipedia.org/wiki/Foo Bar": "https://de.wikipedia.org/wiki/Foo%20Bar",
    "example.com:8080/a b": "https://example.com:8080/a%20b",
    "printer.local:80/My Folder": "http://printer.local:80/My%20Folder",
  };
  for (const [text, url] of Object.entries(opens)) {
    assert.equal(fixupUrl(text), url, text);
    assert.deepEqual(classifyPaste(text), { kind: "go", url }, text);
  }
  for (const text of [
    "asp.net/core vs django",
    "asp.net/core/mvc vs django",
    "github.com/nodejs/node release notes",
    "example.com/My Folder/index.html",
    "node.js/express vs koa",
    "x.com/ cats",
    "192.168.1.2/ cats",
    "x.com/my profile/x",
    "3.5/5 stars rating",
    "AC/DC/ songs/",
    "a/b/c d",
    "example.com#a b",
    "example.com:99999/a b",
    "example.com/search?= cats",
    "asp.net/wiki/Core vs Django",
    "example.com:443/docs release notes",
    "example.com:80/a b",
  ]) {
    assert.equal(fixupUrl(text), null, text);
    assert.deepEqual(classifyPaste(text), { kind: "search", query: text }, text);
  }
  assert.equal(fixupUrl("javascript:123/a b"), null);
  assert.deepEqual(classifyPaste("javascript:123/a b"), { kind: "search", query: "123/a b" });
});

test("a spaced address that could be prose searches first and offers its escaped URL as a guess", () => {
  assert.equal(spacedAddressGuess("asp.net/core vs django"), "https://asp.net/core%20vs%20django");
  assert.equal(spacedAddressGuess("example.com/My Folder/index.html"), "https://example.com/My%20Folder/index.html");
  assert.equal(spacedAddressGuess("github.com/nodejs/node release notes"), "https://github.com/nodejs/node%20release%20notes");
  assert.equal(spacedAddressGuess("asp.net/wiki/Core vs Django"), "https://asp.net/wiki/Core%20vs%20Django");
  assert.equal(spacedAddressGuess("example.com:443/docs release notes"), "https://example.com:443/docs%20release%20notes");
  assert.equal(spacedAddressGuess("example.com# Chapter 2"), "https://example.com#%20Chapter%202");
  for (const text of ["en.wikipedia.org/wiki/Jim Beam", "x.com/ cats", "x.com cats", "AC/DC songs", "foo.notatld/a/b c", "example.com:99999/a b", "javascript:123/a b", "example.com/a\tb"]) {
    assert.equal(spacedAddressGuess(text), null, text);
  }
});

test("Paste and Go still searches a pasted local path with a space, though Enter opens it as a file", () => {
  assert.deepEqual(classifyPaste("/Users/me/My File.html"), { kind: "search", query: "/Users/me/My File.html" });
  assert.equal(fixupUrl("/Users/me/My File.html"), "file:///Users/me/My%20File.html");
});

test("fixupUrl reads the host up to the first / ? or #: one trailing dot, a 1-5 digit port, labels never start or end in a hyphen", () => {
  assert.equal(fixupUrl("example.com./x"), "https://example.com./x");
  assert.equal(fixupUrl("example.com../x"), null);
  assert.equal(fixupUrl("example.com:123456/x"), null);
  assert.equal(fixupUrl("[::1]:"), null);
  assert.equal(fixupUrl("[::1]./"), "http://[::1]./");
  assert.equal(fixupUrl("LOCALHOST:3000"), "http://LOCALHOST:3000");
  assert.equal(fixupUrl("-a.com"), null);
  assert.equal(fixupUrl("a-.com"), null);
  assert.equal(fixupUrl("a.1com/"), null);
  assert.equal(fixupUrl("my-site.xn--p1ai"), "https://my-site.xn--p1ai");
  assert.equal(fixupUrl("my-blog-post.another-post.third-post.fourth-post.fifth-post:"), null);
  assert.equal(fixupUrl("my-blog-post.another-post.third-post.dev/"), "https://my-blog-post.another-post.third-post.dev/");
});

const ascii = (unicode: string) => {
  const host = domainToASCII(unicode);
  assert.ok(host, `${unicode} should be a valid IDN`);
  return host;
};
const shown = (unicode: string) => displayHost(ascii(unicode));

test("mixing Latin with Cyrillic or Greek stays punycode", () => {
  assert.equal(shown("аpple.com"), "xn--pple-43d.com");
  assert.equal(hostSpoofReason(ascii("аpple.com")), "mixedScripts");
  assert.equal(hostSpoofReason(ascii("gοogle.net")), "mixedScripts");
  assert.equal(hostSpoofReason(ascii("пα.com")), "mixedScripts");
});

test("whole-script confusables stay punycode outside their TLDs", () => {
  assert.equal(shown("аррӏе.com"), "xn--80ak6aa92e.com");
  assert.equal(hostSpoofReason("xn--80ak6aa92e.com"), "wholeScriptConfusable");
  assert.equal(shown("аррӏе.ru"), "аррӏе.ru");
  assert.equal(shown("аррӏе.рф"), "аррӏе.рф");
  assert.equal(hostSpoofReason(ascii("ικα.com")), "wholeScriptConfusable");
  assert.equal(shown("ικα.gr"), "ικα.gr");
  assert.equal(hostSpoofReason(ascii("ოყ.com")), "wholeScriptConfusable");
  assert.equal(hostSpoofReason(ascii("ทน.com")), "wholeScriptConfusable");
  assert.equal(hostSpoofReason(ascii("օս.com")), "wholeScriptConfusable");
});

test("dangerous patterns", () => {
  assert.equal(hostSpoofReason(ascii("aノb.com")), "dangerousPattern");
  assert.equal(hostSpoofReason(ascii("abcン.com")), "dangerousPattern");
  assert.equal(hostSpoofReason(ascii("カヘカ.jp")), null);
  assert.equal(hostSpoofReason(ascii("カへカ.jp")), "dangerousPattern");
  assert.equal(hostSpoofReason(ascii("ーabc.jp")), "dangerousPattern");
  assert.equal(hostSpoofReason("xn--" + punycodeEncode("ai\u0307b") + ".com"), "dangerousPattern");
  assert.equal(hostSpoofReason(ascii("oհ.com")), "dangerousPattern");
});

test("cleanUrl drops campaign and click-id parameters", () => {
  assert.equal(
    cleanUrl("https://example.com/post?utm_source=newsletter&utm_medium=email&utm_campaign=fall"),
    "https://example.com/post",
  );
  assert.equal(cleanUrl("https://example.com/?fbclid=IwAR0abc"), "https://example.com/");
  assert.equal(cleanUrl("https://shop.example/item?id=42&gclid=Cj0KCQ&color=red"), "https://shop.example/item?id=42&color=red");
  assert.equal(cleanUrl("https://news.example/a?mc_eid=123&mc_cid=456&page=2"), "https://news.example/a?page=2");
  assert.equal(cleanUrl("https://x.example/?_hsenc=p2A&_hsmi=1&msclkid=9"), "https://x.example/");
  assert.equal(cleanUrl("https://example.com/?UTM_Source=caps"), "https://example.com/");
});

test("cleanUrl keeps the rest of the URL exactly as it was", () => {
  assert.equal(cleanUrl("https://example.com/a?q=a%20b&utm_source=x#section-2"), "https://example.com/a?q=a%20b#section-2");
  assert.equal(cleanUrl("https://example.com/a?utm_source=x#frag?utm_medium=y"), "https://example.com/a#frag?utm_medium=y");
  assert.equal(cleanUrl("https://example.com/search?q=utm_source"), "https://example.com/search?q=utm_source");
  assert.equal(cleanUrl("https://example.com/?b=2&a=1"), "https://example.com/?b=2&a=1");
  assert.equal(cleanUrl("https://example.com/path"), "https://example.com/path");
  assert.equal(cleanUrl("https://user:pw@example.com:8443/p?utm_term=x&k"), "https://user:pw@example.com:8443/p?k");
});

test("cleanUrlReport gives cleanUrl's result and says whether a tracking parameter was really removed", () => {
  assert.deepEqual(cleanUrlReport("https://shop.example/item?id=42&gclid=Cj0KCQ&color=red"), { url: "https://shop.example/item?id=42&color=red", removedTracker: true });
  assert.deepEqual(cleanUrlReport("https://example.com/?q=abc&"), { url: "https://example.com/?q=abc", removedTracker: false });
  assert.deepEqual(cleanUrlReport("https://example.com/?&&"), { url: "https://example.com/", removedTracker: false });
  assert.deepEqual(cleanUrlReport("https://example.com/?q=abc&&fbclid=1"), { url: "https://example.com/?q=abc", removedTracker: true });
  assert.deepEqual(cleanUrlReport("https://example.com/path"), { url: "https://example.com/path", removedTracker: false });
  assert.deepEqual(cleanUrlReport("ardia://history/?utm_source=x"), { url: "ardia://history/?utm_source=x", removedTracker: false });
  for (const url of ["https://example.com/?q=abc&", "https://x.example/?_hsenc=p2A&_hsmi=1&msclkid=9", "https://user:pw@example.com:8443/p?utm_term=x&k", "not a url?utm_source=x"]) assert.equal(cleanUrlReport(url).url, cleanUrl(url));
});

test("displayed URLs say ardia://, never chrome://", () => {
  assert.equal(urlForDisplay("ardia://version/"), "ardia://version");
  assert.equal(urlForDisplay("chrome://version/"), "ardia://version");
  assert.equal(urlForDisplay("chrome://settings/languages"), "ardia://settings/languages");
  assert.equal(urlForDisplay("ardia://history/?q=a"), "ardia://history?q=a");
  assert.equal(displayUrl("chrome://gpu/"), "ardia://gpu");
  assert.deepEqual(breadcrumb("ardia://version/", "About Version"), { host: "ardia://version", trail: ["About Version"] });
  assert.deepEqual(breadcrumb("ardia://history", "History"), { host: "ardia://history", trail: [] });
  assert.deepEqual(breadcrumb("chrome://flags/", "Experiments"), { host: "ardia://flags", trail: ["Experiments"] });
});

test("host:port navigates: single-label intranet hosts over http, a number or a time never", () => {
  assert.equal(fixupUrl("myserver:8080"), "http://myserver:8080");
  assert.equal(fixupUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(fixupUrl("devbox:3000/api/health?x=1"), "http://devbox:3000/api/health?x=1");
  assert.equal(fixupUrl("foo.zzzz:8080"), "https://foo.zzzz:8080");
  assert.equal(resolveInput("myserver:8080", GOOGLE), "http://myserver:8080");
  for (const text of ["10:30", "3:2", "8080", "12:30pm", "ratio 3:2", "note: 5", "a:b", "std::vector"]) assert.equal(fixupUrl(text), null, text);
});

test("IDN hosts navigate, in any script, with or without a path", () => {
  assert.equal(fixupUrl("münchen.de"), "https://münchen.de");
  assert.equal(fixupUrl("Яндекс.рф"), "https://Яндекс.рф");
  assert.equal(fixupUrl("яндекс.рф/search?text=x"), "https://яндекс.рф/search?text=x");
  assert.equal(fixupUrl("例え.jp"), "https://例え.jp");
  assert.equal(fixupUrl("bücher.example/x/"), "https://bücher.example/x/");
  assert.equal(fixupUrl("xn--bcher-kva.de"), "https://xn--bcher-kva.de");
  assert.equal(fixupUrl("café.fr:8443"), "https://café.fr:8443");
  assert.equal(fixupUrl("café"), null);
  assert.equal(fixupUrl("münchen.zzzz"), null);
  assert.equal(fixupUrl("naïve bayes.com"), null);
});

test("an unknown TLD searches unless a port, a trailing slash or two of path, query and fragment say URL", () => {
  assert.equal(fixupUrl("foo.zzzz"), null);
  assert.equal(fixupUrl("foo.zzzz/x"), null);
  assert.equal(fixupUrl("foo.zzzz?x=1"), null);
  assert.equal(fixupUrl("foo.zzzz#top"), null);
  assert.equal(fixupUrl("foo.zzzz/"), "https://foo.zzzz/");
  assert.equal(fixupUrl("foo.zzzz/x/"), "https://foo.zzzz/x/");
  assert.equal(fixupUrl("foo.zzzz/x?y=1"), "https://foo.zzzz/x?y=1");
  assert.equal(fixupUrl("foo.zzzz/x#y"), "https://foo.zzzz/x#y");
  assert.equal(fixupUrl("x.y/"), "https://x.y/");
  assert.equal(fixupUrl("https://foo.zzzz/x"), "https://foo.zzzz/x");
  assert.equal(fixupUrl("http://foo"), "http://foo");
  assert.equal(fixupUrl("foo/bar"), null);
  assert.equal(fixupUrl("foo/"), "http://foo/");
  assert.equal(fixupUrl("wiki/Main?x=1"), "http://wiki/Main?x=1");
  assert.equal(fixupUrl("react"), null);
  assert.equal(fixupUrl("and/or"), null);
});

test("go/<link> opens http://go/<link>: go is the go-link host, other single labels with a path stay searches", () => {
  assert.equal(resolveInput("go/server", GOOGLE), "http://go/server");
  assert.equal(fixupUrl("go/server"), "http://go/server");
  assert.equal(fixupUrl("GO/Team-Wiki"), "http://GO/Team-Wiki");
  assert.equal(fixupUrl("go/a/b"), "http://go/a/b");
  assert.equal(fixupUrl("go/"), "http://go/");
  assert.equal(fixupUrl("go/x?y=1"), "http://go/x?y=1");
  assert.equal(classifyPaste("go/server")?.kind, "go");
  for (const text of ["go", "go server", "go/ server", "go/x y", "go.zzzz/x", "and/or", "foo/bar", "w/o", "tcp/ip", "1/2", "24/7", "c++/x"]) {
    assert.equal(fixupUrl(text), null, text);
  }
  assert.equal(resolveInput("go server", GOOGLE), "https://www.google.com/search?q=go%20server");
  assert.equal(resolveInput("1/2", GOOGLE), "https://www.google.com/search?q=1%2F2");
});

test("a single-label host with a path is an intranet link: it opens when the host is known, as Chrome's typed intranet hosts do", () => {
  assert.equal(intranetLinkHost("wiki/Main"), "wiki");
  assert.equal(intranetLinkHost(" Wiki/Main "), "wiki");
  for (const text of ["wiki", "wiki/", "wiki//x", "wiki:8080/x", "wiki.zzzz/x", "a b/c", "wiki/a b", "localhost/x", "1/2", "/etc/hosts", "https://wiki/x", "c++/x"]) {
    assert.equal(intranetLinkHost(text), null, text);
  }
  const known = (host: string) => host === "wiki";
  assert.equal(intranetUrl("wiki/Main", known), "http://wiki/Main");
  assert.equal(intranetUrl("and/or", known), null);
  assert.equal(intranetUrl("wiki/a b", known), null);
});

test("a known registry navigates with or without a path (Chrome's public suffix list)", () => {
  for (const text of ["site.photography/about", "docs.new", "report.zip", "shop.bike", "hello.world", "a.xn--p1ai", "b.中国", "c.рф"]) {
    assert.ok(fixupUrl(text), text);
  }
  for (const text of ["index.html", "node.js", "e.g.", "1.5", "a.b", "c++", "v1.2.3", "file.txt", "README.md.bak", "hi@example.com"]) {
    assert.equal(fixupUrl(text), null, text);
  }
});

test("random hosts: a known TLD or a port navigates, a bare unknown name or a space never does", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed % n);
  const pick = <T,>(list: readonly T[]): T => list[rnd(list.length)]!;
  const tlds = PSL_TLDS.split(/\s+/).filter((t) => t.length > 1 && t !== "local" && t !== "localhost");
  const labels = ["a", "foo", "my-site", "x1", "münchen", "яндекс", "例え", "9lives", "a-b-c"];
  for (let i = 0; i < 3000; i++) {
    const host = `${pick(labels)}${rnd(3) ? "" : `.${pick(labels)}`}.${pick(tlds)}`;
    const tail = pick(["", "/", "/x", "/x/y?z=1", ":8080", ":8080/x", "?q=1", "#t"]);
    const url = fixupUrl(host + tail);
    assert.ok(url?.endsWith(host + tail), `${host}${tail} → ${url}`);
    assert.equal(fixupUrl(`${host} ${tail}`.trimEnd() + " x"), null, "a space makes it prose");
    const unknown = `${pick(labels)}.${pick(["zzzz", "qqqq", "notatld"])}`;
    const bare = fixupUrl(unknown + pick(["", "/x", "?q=1", "#t"]));
    assert.equal(bare, null, unknown);
    assert.ok(fixupUrl(`${unknown}:${1 + rnd(65535)}`), "a port makes it a URL");
  }
});

test("javascript: never comes out of typed or pasted address bar text", () => {
  for (const text of ["javascript://x%0Aalert(document.domain)", "JAVASCRIPT://x", "view-source:javascript:alert(1)", "javascript:alert(1)"]) {
    assert.equal(fixupUrl(text), null, text);
    assert.ok(!/^javascript:/i.test(resolveInput(text, GOOGLE)), text);
  }
  assert.deepEqual(classifyPaste("javascript://x%0Aalert(document.domain)"), { kind: "search", query: "//x%0Aalert(document.domain)" });
  assert.deepEqual(classifyPaste(" javascript:javascript:alert(1)"), { kind: "search", query: "alert(1)" });
  assert.equal(classifyPaste("javascript:"), null);
  assert.deepEqual(classifyPaste("javascript:example.com"), { kind: "go", url: "https://example.com" });
});

test("display drops userinfo and keeps non-default ports in the host", () => {
  assert.equal(urlForDisplay("https://user:pass@example.com/a"), "example.com/a");
  assert.equal(urlForDisplay("https://accounts.google.com@evil.com/"), "evil.com/");
  assert.equal(urlForDisplay("https://example.com:8443/a"), "example.com:8443/a");
  assert.equal(urlForDisplay("mailto:hi@example.com"), "mailto:hi@example.com");
  assert.equal(breadcrumb("https://example.com:8443/a").host, "example.com:8443");
  assert.equal(breadcrumb("https://example.com:443/a").host, "example.com");
  assert.equal(breadcrumb("http://localhost:3000/").host, "localhost:3000");
  assert.equal(breadcrumb("https://user:pass@example.com/").host, "example.com");
});

test("Latin lookalikes of finance domains stay punycode", () => {
  assert.equal(shown("fidélity.com"), ascii("fidélity.com"));
  assert.equal(shown("schwáb.com"), ascii("schwáb.com"));
  assert.equal(shown("bücher.de"), "bücher.de");
});

test("sameAddress folds only ASCII case in the host, and default ports and the root slash", () => {
  assert.ok(sameAddress("https://EXAMPLE.com:443#x", "https://example.com/#x"));
  assert.ok(sameAddress("http://example.com:0080/a", "http://example.com/a"));
  assert.ok(!sameAddress("https://ΟΣ-example.com/a", "https://ος-example.com/a"));
  assert.ok(sameAddress("https://bücher.de/a", "https://xn--bcher-kva.de/a"));
  assert.ok(sameAddress("https://BÜCHER.de:443/a", "https://XN--BCHER-KVA.de/a"));
  assert.ok(sameAddress("https://ﾌﾞｯｸ.jp/a", "https://xn--pckwb0c.jp/a"));
  assert.ok(!sameAddress("https://example.com/A", "https://example.com/a"));
});

test("a Markdown link never shows trackers in its label, and its destination parses back to the clean address", () => {
  assert.equal(markdownLink("", "https://example.com/a)b?utm_source=mail"), "[https://example.com/a)b](https://example.com/a\\)b)");
  assert.equal(markdownLink("https://x.example/?fbclid=1", "https://x.example/?fbclid=1"), "[https://x.example/](https://x.example/)");
  assert.equal(markdownLink("example.com", "https://www.example.com/?utm_source=mail"), "[example.com](https://www.example.com/)");
  assert.equal(markdownLink("Fish", "https://e.example/?q=fish&copy;&utm_source=x"), "[Fish](https://e.example/?q=fish&amp;copy;)");
  assert.equal(markdownLink("Fish", "https://e.example/a b?q=fish&copy;&x=1"), "[Fish](<https://e.example/a b?q=fish&amp;copy;&x=1>)");
  assert.equal(markdownLink("Plain", "https://e.example/?a=1&b=2&fbclid=3"), "[Plain](https://e.example/?a=1&b=2)");
  assert.equal(markdownLink("Doc", "https://e.example/doc(1)?token=abc(123)&gclid=x"), "[Doc](https://e.example/doc\\(1\\)?token=abc\\(123\\))");
  assert.equal(markdownLink("Shop [sale] \\o/", "https://shop.example/p (1)?id=7&gclid=x"), "[Shop \\[sale\\] \\\\o/](<https://shop.example/p (1)?id=7>)");
  assert.equal(markdownLink("Tab", "https://e.example/<x>"), "[Tab](<https://e.example/\\<x\\>>)");
  assert.equal(markdownLink("Tab", "https://e.example/a\\b"), "[Tab](https://e.example/a\\\\b)");
  assert.equal(markdownLink("Tab", "https://e.example/a\nb"), "[Tab](https://e.example/a%0Ab)");
});

test("a cleaner report can't be rewritten after the fact, and link lists are bulleted only for Markdown with several links", () => {
  const report = cleanUrlReport("https://shop.example/item?id=7&utm_source=mail");
  assert.ok(Object.isFrozen(report));
  assert.throws(() => {
    // @ts-expect-error
    report.url = "https://shop.example/item?id=7&utm_source=mail";
  });
  const one = cleanUrl("https://a.example/?utm_source=x");
  const two = markdownLink("B", "https://b.example/?fbclid=1");
  assert.equal(linkLines([one, two], true), "- https://a.example/\n- [B](https://b.example/)");
  assert.equal(linkLines([one, two], false), "https://a.example/\n[B](https://b.example/)");
  assert.equal(linkLines([two], true), "[B](https://b.example/)");
});

const LABEL_MARKUP = new Set(["\\", "[", "]", "*", "_", "`", "<", ">", "~"]);

function renderedLabel(source: string): string {
  let text = "";
  for (let i = 0; i < source.length; i++) {
    const character = source[i]!;
    if (character === "\\") {
      const next = source[i + 1] ?? "";
      assert.match(next, /[!-/:-@[-`{-~]/, `a backslash that escapes nothing in ${JSON.stringify(source)}`);
      text += next;
      i++;
    } else if (character === "&") {
      const entity = /^&(#?[A-Za-z0-9]+);/.exec(source.slice(i));
      if (!entity) text += "&";
      else {
        assert.equal(entity[1], "amp", `an entity that would render as another character in ${JSON.stringify(source)}`);
        text += "&";
        i += entity[0].length - 1;
      }
    } else {
      assert.ok(!LABEL_MARKUP.has(character), `unescaped ${character} would render as markup in ${JSON.stringify(source)}`);
      assert.doesNotMatch(character, /[\r\n\u2028\u2029]/, `a line break in ${JSON.stringify(source)}`);
      text += character;
    }
  }
  return text;
}

function readMarkdownLink(markdown: string): { label: string; destination: string } {
  const link = /^\[((?:\\.|[^\\\]])*)\]\((<(?:\\.|[^\\>\n])*>|(?:\\.|[^\\()\s])*)\)$/.exec(markdown);
  assert.ok(link, `not one CommonMark inline link: ${JSON.stringify(markdown)}`);
  const raw = link[2]!;
  const destination = (raw.startsWith("<") ? raw.slice(1, -1) : raw).replace(/\\([()<>\\])/g, "$1").replace(/&amp;/g, "&");
  return { label: renderedLabel(link[1]!), destination };
}

test("every Markdown link reads back as one link whose destination is the clean address and whose label sits on one line", () => {
  const titles = ["https://other.example/p?ref=1&utm_campaign=z", "Line one\n\nLine two", "A\r\nB\u2028C\u2029D", "\n\n", "Shop [sale] \\o/", "", "Plain", "*literal*", "snake_case_title", "`code`", "<b>bold</b>", "~~gone~~", "AT&T &copy; &#169;", "!\\[img]"];
  const urls = [
    "https://e.example/a?utm_source=x",
    "https://e.example/doc(1)?token=abc(123)&gclid=x",
    "https://e.example/p (1)?q=fish&copy;&x=1",
    "https://e.example/<x>?a=1&#38;b",
    "https://e.example/a\\b?fbclid=1",
  ];
  for (const title of titles)
    for (const url of urls) {
      const { label, destination } = readMarkdownLink(markdownLink(title, url));
      assert.equal(destination, cleanUrl(url), `${JSON.stringify(title)} ${url}`);
      const shown = title.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
      assert.equal(label, !shown || shown === url ? cleanUrl(url) : cleanUrl(shown), JSON.stringify(title));
    }
});

test("a link title that is a tracked address loses its trackers, and any other title only its line breaks", () => {
  const url = "https://shop.example/item?id=7&utm_source=mail";
  assert.equal(cleanLinkTitle(url, url), "https://shop.example/item?id=7");
  assert.equal(cleanLinkTitle(`  ${url}\n`, url), "https://shop.example/item?id=7");
  assert.equal(cleanLinkTitle("https://other.example/p?ref=1&utm_campaign=z", url), "https://other.example/p?ref=1");
  assert.equal(cleanLinkTitle("Shop\n\nItem ?utm_source=x", url), "Shop Item ?utm_source=x");
  assert.equal(cleanLinkTitle("Item & more", url), "Item & more");
  for (const empty of ["", "  \n ", null, undefined]) assert.equal(cleanLinkTitle(empty, url), "");
});

test("a title that is the page's tracked address with whitespace around it is labelled with the clean address", () => {
  const url = "https://shop.example/item?id=7&utm_source=mail";
  assert.equal(markdownLink(`  ${url}\n`, url), "[https://shop.example/item?id=7](https://shop.example/item?id=7)");
  assert.equal(markdownLink(`\t${url} `, url), "[https://shop.example/item?id=7](https://shop.example/item?id=7)");
  assert.equal(markdownLink(`${url}#reviews`, url), "[https://shop.example/item?id=7#reviews](https://shop.example/item?id=7)");
  assert.equal(markdownLink("https://shop.example/?gclid=1", "https://shop.example/"), "[https://shop.example/](https://shop.example/)");
});
