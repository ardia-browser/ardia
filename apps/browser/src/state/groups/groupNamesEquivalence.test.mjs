import assert from "node:assert/strict";
import { test } from "node:test";
const live = await import("./groupNames.ts");
const reference = await import("./groupNamesReference.ts");

function rng(seed) {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const int = (n) => Math.floor(next() * n);
  return { int, pick: (l) => l[int(l.length)] };
}

const HOSTS = [
  "github.com", "www.github.com", "docs.github.com", "x.com", "news.ycombinator.com", "en.wikipedia.org", "news.bbc.co.uk",
  "127.0.0.1:9471", "[::1]:8080", "localhost:3000", "café.example", "xn--caf-dma.example", "mail.google.com", "a.b", " x.com", "ab.cd",
];
const OTHER_URLS = ["about:blank", "file:///Users/a/b.txt", "ardia://settings", "not a url", "", "data:text/plain,hi"];
const SEPARATORS = [" / ", " | ", " - ", " — ", " – ", " · ", " • ", " :: "];
const FAKE_SEPARATORS = ["-", "|", ":", " ", "/", "::", " :", "— ", " —", "  -  ", " - ", "　|　"];
const SPACES = ["", "", "", " ", "  ", "\t", " ", "　", "﻿", " ", " ", "\n", "​", "᠎"];
const WORDS = [
  "GitHub", "github", "Github", "X", "x", "Hacker News", "news", "Wikipedia", "wikipedia", "BBC", "bbc", "Google", "Gmail", "Inbox",
  "Page", "Pull Request #42", "Issues", "README.md", "Café", "日本語", "😀", "a", "ab", "abc", "Home", "Settings", "127.0.0.1",
  "localhost", "Example", "one two three four", "Docs", "-", "|", "the GitHub blog", "ycombinator", "Wiki",
];

function makeTitle(r, url) {
  const roll = r.int(20);
  if (roll === 0) return "";
  if (roll === 1) return url;
  if (roll === 2) return undefined;
  const parts = 1 + r.int(4);
  let title = r.pick(SPACES);
  for (let i = 0; i < parts; i++) {
    if (i) title += r.int(5) ? r.pick(SEPARATORS) : r.pick(FAKE_SEPARATORS);
    title += r.pick(SPACES) + r.pick(WORDS) + r.pick(SPACES);
  }
  return title;
}

function makeUrl(r, hosts) {
  if (!r.int(12)) return r.pick(OTHER_URLS);
  return `${r.pick(["https", "http", "HTTPS"])}://${r.pick(hosts)}/${r.pick(["", "a", "page/1", "x?y=1#z"])}`;
}

function makeGroup(r) {
  const hosts = Array.from({ length: 1 + r.int(3) }, () => r.pick(HOSTS));
  const size = r.int(9) ? 1 + r.int(12) : 1;
  const sameTitle = r.int(3) === 0 ? makeTitle(r, "https://github.com/") : null;
  const members = [];
  for (let i = 0; i < size; i++) {
    const url = members.length && !r.int(6) ? r.pick(members).url : makeUrl(r, hosts);
    let title = makeTitle(r, url);
    if (sameTitle && r.int(2) && typeof title === "string" && title) title = r.int(2) ? `${sameTitle}${r.pick(SEPARATORS)}${r.pick(WORDS)}` : `${r.pick(WORDS)}${r.pick(SEPARATORS)}${sameTitle}`;
    members.push({ url, title });
  }
  return members;
}

function assertSame(members, message) {
  const want = reference.autoGroupName(members);
  assert.equal(live.autoGroupName(members), want, message);
  assert.equal(live.autoGroupName(members.map((m) => ({ ...m }))), want, message);
  if (members.length) assert.equal(live.siteName(members), reference.siteName(members), message);
}

test("autoGroupName and siteName name random groups exactly as the reference does", () => {
  const outcomes = new Set();
  for (let seed = 1; seed <= 4000; seed++) {
    const r = rng(seed);
    const members = makeGroup(r);
    assertSame(members, `seed ${seed}: ${JSON.stringify(members)}`);
    outcomes.add(reference.autoGroupName(members));
  }
  assert.ok(outcomes.size > 300, `only ${outcomes.size} distinct names`);
});

test("groups whose titles share a site name through every separator match the reference", () => {
  const sites = ["GitHub", "Hacker News", "Wikipedia", "Café", "日本語", "x", "Mail · Google", "a b c d"];
  const hosts = ["github.com", "news.ycombinator.com", "en.wikipedia.org", "café.example", "example.jp", "x.com", "mail.google.com", "abcd.com"];
  const spaces = ["", " ", " ", "　", "\t", "﻿"];
  let seed = 0;
  for (const sep of SEPARATORS)
    for (let s = 0; s < sites.length; s++)
      for (const around of spaces) {
        const r = rng(++seed);
        const site = sites[s];
        const pages = ["Issues", "Pull requests", "Issues", "Home"].slice(0, 1 + r.int(4));
        const members = pages.map((page, i) => {
          const before = r.int(2);
          const title = before ? `${around}${site}${around}${sep}${around}${page}${around}` : `${around}${page}${around}${sep}${around}${site}${around}`;
          return { url: `https://${hosts[s]}/${i}`, title };
        });
        assertSame(members, `${JSON.stringify(sep)} ${site} ${JSON.stringify(around)}`);
        assertSame([members[0]], `one member ${JSON.stringify(members[0])}`);
        assertSame([...members, { url: members[0].url, title: "" }], "an unloaded copy of a loaded url");
        assertSame([...members, { url: `https://${hosts[s]}/unloaded`, title: "" }], "an unloaded member");
      }
});

test("every whitespace character is trimmed exactly as String.prototype.trim trims it", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const c = String.fromCharCode(code);
    const members = [
      { url: "https://example.com/a", title: `One${c} - ${c}EXAMPLE${c}` },
      { url: "https://example.com/b", title: `${c}EXAMPLE${c}${c} - Two` },
    ];
    const want = reference.autoGroupName(members);
    assert.equal(live.autoGroupName(members), want, `U+${code.toString(16)}`);
    const site = [{ url: "https://example.com/a", title: `${c}x - Page` }, { url: "https://example.com/b", title: `Other - ${c}x` }];
    assert.equal(live.autoGroupName(site), reference.autoGroupName(site), `U+${code.toString(16)} around the site`);
  }
});

test("a member whose url changes is named from its new host", () => {
  const member = { url: "https://github.com/a", title: "" };
  assert.equal(live.autoGroupName([member]), "Github");
  member.url = "https://x.com/a";
  assert.equal(live.autoGroupName([member]), "X");
  assert.equal(live.siteName([member]), "X");
});

test("an empty group has no name", () => {
  assert.equal(live.autoGroupName([]), reference.autoGroupName([]));
  assert.equal(live.siteName([]), reference.siteName([]));
});

test("a host whose label starts or ends with whitespace never matches a trimmed title part", () => {
  for (const host of [" x.com", " x.com", "\tx.com", " github.com"]) {
    const label = host.trim().split(".")[0];
    for (const sep of SEPARATORS)
      for (const gap of ["", " ", "  ", " "]) {
        const members = [
          { url: `https://${host}/a`, title: `Foo${sep}${gap}${label}` },
          { url: `https://${host}/b`, title: "Foo" },
        ];
        assertSame(members, JSON.stringify(members));
        assertSame([members[1], members[0]], JSON.stringify(members));
      }
  }
});
