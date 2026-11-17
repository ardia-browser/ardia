import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BUILT_IN_ENGINES, engineById, parseRemoteSuggestions, parseSuggestions } from "./engines.ts";
import { buildSuggestions, suggestionKey, type Suggestion } from "./suggest.ts";
import { createSuggestFetcher, type FetchLike } from "./suggestFetcher.ts";

const now = Date.UTC(2026, 8, 24);
const DAY = 86_400_000;
const history = [
  { url: "https://x.com/home", title: "(1) Home / X", favicon: null, visits: 40, lastVisit: now - 1000 },
  { url: "https://x.com/notifications", title: "Notifications / X", favicon: null, visits: 5, lastVisit: now - 5000 },
  { url: "https://www.xing.com/", title: "XING", favicon: null, visits: 1, lastVisit: now - DAY * 10 },
  { url: "https://github.com/", title: "GitHub", favicon: null, visits: 12, lastVisit: now - 2000 },
];

function rows(items: Suggestion[]): string[] {
  return items.map((i) => {
    switch (i.kind) {
      case "page":
        return i.tabId ? `tab:${i.url}` : i.url;
      case "search":
        return `${i.suggested ? "suggest" : "search"}:${i.query}`;
      case "calc":
        return `calc:${i.value}`;
      case "action":
        return `action:${i.id}`;
      case "create":
        return `create:${i.id}`;
      case "extension":
        return `extension:${i.open}:${i.id}`;
      case "provider":
        return `provider:${i.providerId}:${i.url}`;
    }
  });
}

test("inline completion never takes a long query URL: 'm' completes to the host", () => {
  const signIn =
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F&service=mail&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin#inbox";
  const hist = [
    { url: "https://mail.google.com/mail/u/0/?service=mail&continue=" + encodeURIComponent(signIn) + "#inbox", title: "Inbox - me@gmail.com - Gmail", favicon: "gmail.ico", visits: 50, lastVisit: now - 1000 },
    { url: signIn, title: "Sign in - Google Accounts", favicon: null, visits: 3, lastVisit: now - 2000 },
  ];
  const m = buildSuggestions("m", { tabs: [], history: hist }, { now });
  assert.equal(m.completion, "ail.google.com");
  assert.deepEqual(m.items[0], { kind: "page", url: "https://mail.google.com/", title: "", favicon: "gmail.ico" });
  assert.ok(rows(m.items).includes(hist[0]!.url));
  const a = buildSuggestions("a", { tabs: [], history: hist }, { now });
  assert.equal(a.completion, "ccounts.google.com");
  assert.equal(buildSuggestions("mail.google.com/m", { tabs: [], history: hist }, { now }).completion, "");
  assert.equal(buildSuggestions("x.com/h", { tabs: [], history }, { now }).completion, "ome");
});

test("free text puts a search first-class and never autocompletes", () => {
  const { items, completion } = buildSuggestions("git hub", { tabs: [], history }, { now });
  assert.equal(completion, "");
  assert.equal(items[0]?.kind, "search");
});

test("preventInline (after a deletion): no completion, and the search is first unless the typed text is the page", () => {
  const typed = (text: string, preventInline: boolean) => buildSuggestions(text, { tabs: [], history }, { now, preventInline });
  const before = typed("gi", false);
  assert.equal(before.completion, "thub.com");
  assert.equal(rows(before.items)[0], "https://github.com/");
  const after = typed("gi", true);
  assert.equal(after.completion, "");
  assert.equal(rows(after.items)[0], "search:gi");
  assert.ok(rows(after.items).includes("https://github.com/"), "the page stays in the list");
  assert.equal(rows(typed("gith", true).items)[0], "search:gith");
  assert.equal(rows(typed("x.c", true).items)[0], "search:x.c");
  assert.equal(rows(typed("github.com", true).items)[0], "https://github.com/");
  assert.equal(typed("github.com", true).completion, "");
  assert.equal(rows(typed("x.com/home", true).items)[0], "https://x.com/home");
  assert.equal(rows(typed("https://x.com/notifications", true).items)[0], "https://x.com/notifications");
  assert.equal(typed("git", false).completion, "hub.com");
});

test("a word of four letters or more lists up to four matching actions, a shorter one two", () => {
  const actions = [
    { id: "split:right", title: "Split View Side by Side" },
    { id: "split:bottom", title: "Split View Stacked" },
    { id: "split:withTab", title: "Split View with Tab" },
    { id: "split:exit", title: "Exit Split View" },
    { id: "split:flip", title: "Flip Split View" },
    { id: "newTab", title: "New Tab" },
  ];
  const actionRows = (q: string) => rows(buildSuggestions(q, { tabs: [], history }, { now, actions }).items).filter((r) => r.startsWith("action:"));
  assert.deepEqual(actionRows("split").sort(), ["action:split:bottom", "action:split:exit", "action:split:right", "action:split:withTab"]);
  assert.equal(actionRows("sp").length, 2);
  assert.deepEqual(actionRows("exit split"), ["action:split:exit"]);
  assert.deepEqual(actionRows("github"), []);
});

test("preventInline keeps quick-create, actions and calculator rules", () => {
  const actions = [{ id: "newTab", title: "New Tab" }] as never;
  assert.equal(rows(buildSuggestions("new tab", { tabs: [], history }, { now, actions, preventInline: true }).items)[0], "action:newTab");
  assert.equal(rows(buildSuggestions("2+2", { tabs: [], history }, { now, preventInline: true }).items)[0], "search:2+2");
});

test("a word and a space: no completion, the search goes first unless it is the host or address", () => {
  const typed = (text: string, o = {}) => buildSuggestions(text, { tabs: [], history }, { now, ...o });
  assert.equal(typed("git").completion, "hub.com");
  for (const text of ["git ", "git  ", "gi\t", "x "]) {
    const r = typed(text);
    assert.equal(r.completion, "", JSON.stringify(text));
    assert.equal(rows(r.items)[0], `search:${text.trim()}`, JSON.stringify(text));
    assert.ok(rows(r.items).includes("https://github.com/") || text.startsWith("x"), "the page stays in the list");
  }
  assert.equal(rows(typed("github.com ").items)[0], "https://github.com/");
  assert.equal(typed("github.com ").completion, "");
  assert.equal(rows(typed("x.com/home ").items)[0], "https://x.com/home");
  assert.equal(typed(" git").completion, "hub.com");
  assert.equal(typed("git hub ").completion, "");
  assert.equal(rows(typed("git s").items)[0], "search:git s");
});

test("only a visited page completes: a bookmark or an open tab with no history row doesn't", () => {
  const bookmarks = [{ url: "https://bookmarked.example.org/", title: "Reading list", favicon: null }];
  const tabs = [{ id: "t9", url: "https://news.ycombinator.com/", title: "Hacker News", favicon: null }];
  const r = buildSuggestions("bookm", { tabs, history, bookmarks }, { now });
  assert.equal(r.completion, "");
  assert.ok(rows(r.items).includes("https://bookmarked.example.org/"), "still a row");
  const t = buildSuggestions("news", { tabs, history, bookmarks }, { now });
  assert.equal(t.completion, "");
  assert.ok(rows(t.items).includes("tab:https://news.ycombinator.com/"), "still a switch-to-tab row");
  const visited = [...history, { url: "https://bookmarked.example.org/", title: "Reading list", favicon: null, visits: 1, lastVisit: now - 9000 }];
  assert.equal(buildSuggestions("bookm", { tabs: [], history: visited, bookmarks }, { now }).completion, "arked.example.org");
  const tabbed = [...history, { url: "https://news.ycombinator.com/", title: "Hacker News", favicon: null, visits: 2, lastVisit: now - 9000 }];
  assert.equal(buildSuggestions("news", { tabs, history: tabbed, bookmarks }, { now }).completion, ".ycombinator.com");
  const deep = [{ url: "https://bookmarked.example.org/a/b", title: "Deep", favicon: null }];
  const host = [...history, { url: "https://bookmarked.example.org/", title: "Home", favicon: null, visits: 3, lastVisit: now - 100 }];
  assert.equal(buildSuggestions("bookm", { tabs: [], history: host, bookmarks: deep }, { now }).completion, "arked.example.org");
});

test("a visited bookmark is found by its own name as well as by the page's title", () => {
  const url = "https://app.example.org/d/42";
  const visited = [...history, { url, title: "Builder Dashboard", favicon: null, visits: 3, lastVisit: now - 9000 }];
  const page = (q: string, bookmarks: { url: string; title: string; favicon: null }[]) =>
    buildSuggestions(q, { tabs: [], history: visited, bookmarks }, { now }).items.find((i) => i.kind === "page" && i.url === url);
  const row = (title: string) => ({ kind: "page", url, title, favicon: null, bookmarked: true, visited: true });
  const named = [{ url, title: "All Embeddables", favicon: null }];
  assert.deepEqual(page("all embe", named), row("All Embeddables"));
  assert.deepEqual(page("embeddables", named), row("All Embeddables"));
  assert.deepEqual(page("builder", named), row("All Embeddables"));
  assert.deepEqual(page("builder", [{ url, title: "", favicon: null }]), row("Builder Dashboard"));
});

test("open tabs are marked so the bar can switch to them, except the bar's own tab", () => {
  const tabs = [{ id: "t1", url: "https://github.com/pulls", title: "Pull requests", favicon: null }];
  const { items } = buildSuggestions("pull", { tabs, history }, { now });
  assert.equal(items[0]?.kind === "page" && items[0].tabId, "t1");
  const own = buildSuggestions("pull", { tabs, history }, { now, currentTabId: "t1" });
  assert.ok(!own.items.some((i) => i.kind === "page" && i.tabId));
});

const pageRows = (items: Suggestion[]) => items.flatMap((i) => (i.kind === "page" ? [{ url: i.url, title: i.title, tabId: i.tabId }] : []));

test("a renamed tab is found by its custom title, with or without a history or bookmark row for its URL", () => {
  const url = "https://linear.app/team/board";
  const tab = { id: "t7", url, title: "Linear – Issues", customTitle: "Work board", favicon: null };
  const visited = [...history, { url, title: "Linear – Issues", favicon: null, visits: 6, lastVisit: now - 3000 }];
  const bookmarks = [{ url, title: "Linear – Issues", favicon: null }];
  const sources = {
    "no history": { tabs: [tab], history },
    history: { tabs: [tab], history: visited },
    bookmark: { tabs: [tab], history, bookmarks },
  };
  for (const [label, source] of Object.entries(sources)) {
    for (const typed of ["work board", "Work Board", "work", "wo", "board", "linear issues"]) {
      const found = pageRows(buildSuggestions(typed, source, { now }).items);
      assert.deepEqual(found, [{ url, title: "Work board", tabId: "t7" }], `${label}: ${typed}`);
    }
  }
  const row = buildSuggestions("work board", sources.history, { now }).items.find((i) => i.kind === "page");
  assert.equal(row?.kind === "page" && row.visited, true);
  const marked = buildSuggestions("work board", sources.bookmark, { now }).items.find((i) => i.kind === "page");
  assert.equal(marked?.kind === "page" && marked.bookmarked, true);
});

test("a renamed tab still matches the title its history or bookmark row was saved under", () => {
  const url = "https://example.com/dashboard";
  const tab = { id: "t7", url, title: "Example Dashboard", customTitle: "Work board", favicon: null };
  const sources = {
    bookmark: { tabs: [tab], history, bookmarks: [{ url, title: "Quarterly Budget", favicon: null }] },
    history: { tabs: [tab], history: [...history, { url, title: "Quarterly Budget", favicon: null, visits: 4, lastVisit: now - 3000 }] },
  };
  for (const [label, source] of Object.entries(sources)) {
    for (const typed of ["quarterly", "budget", "quarterly budget", "work board", "example dashboard"]) {
      assert.deepEqual(pageRows(buildSuggestions(typed, source, { now }).items), [{ url, title: "Work board", tabId: "t7" }], `${label}: ${typed}`);
    }
  }
});

test("a typed address keeps opening the saved page, even when a renamed tab is on another fragment of it", () => {
  const saved = "https://example.com/docs";
  const open = `${saved}#intro`;
  const tabs = [{ id: "t7", url: open, title: "Docs", customTitle: "Work board", favicon: null }];
  const hist = [...history, { url: saved, title: "Docs", favicon: null, visits: 4, lastVisit: now - 3000 }];
  for (const typed of [saved, "example.com/docs"]) {
    const items = buildSuggestions(typed, { tabs, history: hist }, { now }).items;
    const first = items[0];
    assert.equal(first?.kind === "page" && first.url, saved, `${typed}: opens the saved page first`);
    assert.equal(first?.kind === "page" && first.tabId, undefined, `${typed}: first row opens, it does not switch`);
    assert.equal(first?.kind === "page" && first.title, "Docs", `${typed}: first row keeps the saved title`);
    assert.ok(items.some((i) => i.kind === "page" && i.tabId === "t7" && i.url === open && i.title === "Work board"), `${typed}: the Switch to Tab row opens the tab's own address`);
  }
});

test("a typed address row shows the page's own title, whatever a tab on it was renamed to", () => {
  const url = "https://linear.app/team/board";
  const tab = { id: "t7", url, title: "Linear – Issues", customTitle: "Work board", favicon: null };
  const visited = [...history, { url, title: "Linear – Issues", favicon: null, visits: 6, lastVisit: now - 3000 }];
  const cases = [
    { label: "no history", source: { tabs: [tab], history }, typed: [url] },
    { label: "history", source: { tabs: [tab], history: visited }, typed: [url, "linear.app/team/b"] },
  ];
  for (const { label, source, typed } of cases) {
    for (const text of typed) {
      const items = buildSuggestions(text, source, { now }).items;
      const first = items[0];
      assert.deepEqual(first?.kind === "page" && { url: first.url, title: first.title, tabId: first.tabId }, { url, title: "Linear – Issues", tabId: undefined }, `${label}: ${text}`);
      assert.ok(items.some((i) => i.kind === "page" && i.tabId === "t7" && i.title === "Work board"), `${label}: ${text}: the tab keeps its Switch to Tab row`);
    }
  }
});

test("a renamed tab on a fragment of a saved page leaves the path completion and the saved address as they were", () => {
  const saved = "https://example.com/docs/guide";
  const hist = [...history, { url: saved, title: "Guide", favicon: null, visits: 4, lastVisit: now - 3000 }];
  const tab = { id: "t7", url: `${saved}#intro`, title: "Guide", customTitle: "Work board", favicon: null };
  for (const typed of ["example.com/docs/g", "example.com/docs/guide"]) {
    const alone = buildSuggestions(typed, { tabs: [], history: hist }, { now });
    assert.equal(alone.completion === "", typed.endsWith("guide"), `${typed}: the saved page completes unless it is typed in full`);
    const renamed = buildSuggestions(typed, { tabs: [tab], history: hist }, { now });
    assert.equal(renamed.completion, alone.completion, `${typed}: the completion is the same`);
    const first = renamed.items[0];
    assert.equal(first?.kind === "page" && first.url, saved, `${typed}: the first row opens the saved address`);
    assert.equal(first?.kind === "page" && first.tabId, undefined, `${typed}: the first row opens, it does not switch`);
    assert.deepEqual(first, alone.items[0], `${typed}: the first row is the one without the tab`);
  }
  const switching = buildSuggestions("work board", { tabs: [tab], history: hist }, { now }).items.find((i) => i.kind === "page");
  assert.deepEqual(switching?.kind === "page" && { url: switching.url, title: switching.title, tabId: switching.tabId }, { url: tab.url, title: "Work board", tabId: "t7" });
});

test("a tab without a custom title keeps showing its page title", () => {
  const url = "https://linear.app/team/board";
  const visited = [...history, { url, title: "Linear – Issues", favicon: null, visits: 6, lastVisit: now - 3000 }];
  for (const customTitle of [undefined, null, ""]) {
    const tabs = [{ id: "t7", url, title: "Linear – Issues", customTitle, favicon: null }];
    for (const source of [{ tabs, history }, { tabs, history: visited }]) {
      assert.deepEqual(pageRows(buildSuggestions("linear issues", source, { now }).items), [{ url, title: "Linear – Issues", tabId: "t7" }], String(customTitle));
    }
  }
});

test("of two tabs on one page, the renamed one is the tab the bar switches to", () => {
  const url = "https://linear.app/team/board";
  const plain = { id: "t1", url, title: "Linear – Issues", customTitle: null, favicon: null };
  const named = { id: "t2", url, title: "Linear – Issues", customTitle: "Work board", favicon: null };
  const visited = [...history, { url, title: "Linear – Issues", favicon: null, visits: 6, lastVisit: now - 3000 }];
  for (const tabs of [[plain, named], [named, plain]]) {
    for (const source of [{ tabs, history }, { tabs, history: visited }]) {
      assert.deepEqual(pageRows(buildSuggestions("work board", source, { now }).items), [{ url, title: "Work board", tabId: "t2" }]);
    }
  }
});

test("two renamed tabs on one page are each found by their own custom title", () => {
  const url = "https://linear.app/team/board";
  const first = { id: "t1", url, title: "Linear – Issues", customTitle: "Work board", favicon: null };
  const second = { id: "t2", url, title: "Linear – Issues", customTitle: "Triage", favicon: null };
  const plain = { id: "t3", url, title: "Linear – Issues", customTitle: null, favicon: null };
  const visited = [...history, { url, title: "Linear – Issues", favicon: null, visits: 6, lastVisit: now - 3000 }];
  const bookmarks = [{ url, title: "Linear – Issues", favicon: null }];
  for (const tabs of [[first, second], [second, first], [plain, first, second], [first, plain, second]]) {
    const sources = { "no history": { tabs, history }, history: { tabs, history: visited }, bookmark: { tabs, history, bookmarks } };
    for (const [label, source] of Object.entries(sources)) {
      assert.deepEqual(pageRows(buildSuggestions("work board", source, { now }).items), [{ url, title: "Work board", tabId: "t1" }], `${label}: work board`);
      assert.deepEqual(pageRows(buildSuggestions("triage", source, { now }).items), [{ url, title: "Triage", tabId: "t2" }], `${label}: triage`);
      const byPage = pageRows(buildSuggestions("linear issues", source, { now }).items);
      assert.equal(byPage.length, 1, `${label}: one row for the page title`);
      assert.ok(byPage[0]!.tabId === "t1" || byPage[0]!.tabId === "t2", `${label}: the page title switches to a renamed tab`);
    }
  }
});

test("a typed or completed address opens, even when a tab has it open: the tab keeps a Switch to Tab row", () => {
  const tabs = [{ id: "t1", url: "https://ugc.hekuto.dev/#grid", title: "UGC Radar", favicon: null }];
  const hist = [{ url: "https://ugc.hekuto.dev/#grid", title: "UGC Radar", favicon: null, visits: 3, lastVisit: now - 1000 }];
  for (const typed of ["ugc.hekuto.dev", "ugc.hek", "https://ugc.hekuto.dev/#grid"]) {
    const r = rows(buildSuggestions(typed, { tabs, history: hist }, { now }).items);
    assert.ok(r[0]!.startsWith("https://ugc.hekuto.dev/"), `${typed}: opens first, got ${r[0]}`);
    assert.ok(r.includes("tab:https://ugc.hekuto.dev/#grid"), `${typed}: still a switch-to-tab row`);
  }
});

test("a typed address opens as typed: a saved #fragment of the same page never replaces it", () => {
  const portal = "https://example.awsapps.com/start/";
  const bare = "https://example.awsapps.com/start";
  const saved = `${portal}#/console?account_id=1&role_name=admin`;
  const hist = [{ url: saved, title: "AWS access portal", favicon: "aws.ico", visits: 4, lastVisit: now - 1000 }];
  const tabs = [{ id: "t1", url: saved, title: "AWS access portal", favicon: "aws.ico" }];
  const firstRow = (typed: string, source: Parameters<typeof buildSuggestions>[1]) => buildSuggestions(typed, source, { now }).items[0];
  const opens = (url: string) => ({ kind: "page", url, title: "AWS access portal", favicon: "aws.ico" });
  for (const [typed, url] of [[portal, portal], ["example.awsapps.com/start/", portal], [bare, bare], ["example.awsapps.com/start", bare]] as const) {
    assert.deepEqual(firstRow(typed, { tabs: [], history: hist }), opens(url), `${typed}: history`);
    assert.deepEqual(firstRow(typed, { tabs, history: [] }), opens(url), `${typed}: tab`);
    assert.ok(rows(buildSuggestions(typed, { tabs, history: hist }, { now }).items).includes(`tab:${saved}`), `${typed}: the tab keeps its Switch to Tab row`);
  }
  for (const [typed, url] of [[portal, portal], ["example.awsapps.com/start", bare]] as const) assert.deepEqual(rows(buildSuggestions(typed, { tabs: [], history: hist }, { now }).items).slice(0, 3), [url, `search:${typed}`, saved], `${typed}: the saved page stays a separate choice`);
  assert.equal(rows(buildSuggestions(saved, { tabs: [], history: hist }, { now }).items).filter((r) => r === saved).length, 1, "the saved address as typed is not listed twice");
  const other = `${portal}#/other`;
  assert.deepEqual(firstRow(other, { tabs: [], history: hist }), opens(other), "another typed fragment");
  assert.deepEqual(firstRow(saved, { tabs: [], history: hist }), { ...opens(saved), visited: true }, "the saved address as typed stays a history row");
  const bookmarks = [{ url: saved, title: "AWS access portal", favicon: "aws.ico" }];
  assert.deepEqual(firstRow(portal, { tabs: [], history: hist, bookmarks }), opens(portal), "a changed address is not the bookmark");
  assert.deepEqual(firstRow(saved, { tabs: [], history: hist, bookmarks }), { ...opens(saved), visited: true, bookmarked: true }, "the saved address keeps its bookmark");
  const grid = [{ url: "https://ugc.hekuto.dev/#grid", title: "UGC Radar", favicon: null, visits: 3, lastVisit: now - 1000 }];
  for (const typed of ["ugc.hek", "ugc.hekuto.dev"]) assert.equal(rows(buildSuggestions(typed, { tabs: [], history: grid }, { now }).items)[0], "https://ugc.hekuto.dev/", `${typed}: the host, not the saved #grid`);
});

test("a typed address keeps its trailing slash, except a bare host's, which is the same address", () => {
  const entry = (url: string) => [{ url, title: "Page", favicon: null, visits: 2, lastVisit: now - 1000 }];
  const first = (typed: string, url: string) => buildSuggestions(typed, { tabs: [], history: entry(url) }, { now }).items[0];
  assert.deepEqual(first("https://a.com/page/", "https://a.com/page"), { kind: "page", url: "https://a.com/page/", title: "Page", favicon: null });
  assert.deepEqual(first("https://a.com/page", "https://a.com/page/"), { kind: "page", url: "https://a.com/page", title: "Page", favicon: null });
  assert.deepEqual(first("a.com/page", "https://a.com/page/#x"), { kind: "page", url: "https://a.com/page", title: "Page", favicon: null });
  assert.deepEqual(first("https://a.com", "https://a.com/"), { kind: "page", url: "https://a.com/", title: "Page", favicon: null, visited: true });
  assert.deepEqual(first("a.com/", "https://a.com/"), { kind: "page", url: "https://a.com/", title: "Page", favicon: null, visited: true });
});

test("a typed address saved under a fragment that is not its page's top row keeps that row's own title and flags", () => {
  const history = [
    { url: "https://a.com/#/a", title: "Route A", favicon: "a.ico", visits: 5, lastVisit: now - 100 },
    { url: "https://a.com/#/b", title: "Route B", favicon: "b.ico", visits: 1, lastVisit: now - 200 },
  ];
  const first = (typed: string, bookmarks?: Parameters<typeof buildSuggestions>[1]["bookmarks"]) => buildSuggestions(typed, { tabs: [], history, bookmarks }, { now }).items[0];
  assert.deepEqual(first("https://a.com/#/b"), { kind: "page", url: "https://a.com/#/b", title: "Route B", favicon: "b.ico", visited: true });
  assert.deepEqual(first("https://a.com/#/b", [{ url: "https://a.com/#/b", title: "B", favicon: null }]), { kind: "page", url: "https://a.com/#/b", title: "Route B", favicon: "b.ico", visited: true, bookmarked: true });
  assert.deepEqual(first("https://a.com/#/c", [{ url: "https://a.com/#/b", title: "B", favicon: null }]), { kind: "page", url: "https://a.com/#/c", title: "Route A", favicon: "a.ico" });
  const withHome = [...history, { url: "https://a.com/", title: "Home", favicon: "home.ico", visits: 1, lastVisit: now - 300 }];
  assert.deepEqual(buildSuggestions("https://a.com/", { tabs: [], history: withHome }, { now }).items[0], { kind: "page", url: "https://a.com/", title: "Home", favicon: "home.ico", visited: true });
});

test("a bare host typed with or without its slash finds the saved row either way, and removing it removes that entry", () => {
  const history = [
    { url: "https://a.com/#/a", title: "Route A", favicon: "a.ico", visits: 5, lastVisit: now - 100 },
    { url: "https://a.com", title: "Home", favicon: "home.ico", visits: 1, lastVisit: now - 300 },
  ];
  const bookmarks = [{ url: "https://a.com", title: "Home", favicon: "home.ico" }];
  for (const typed of ["https://a.com", "https://a.com/", "a.com"]) {
    const first = buildSuggestions(typed, { tabs: [], history, bookmarks }, { now }).items[0];
    assert.deepEqual(first, { kind: "page", url: "https://a.com", title: "Home", favicon: "home.ico", visited: true, bookmarked: true }, typed);
    assert.ok(history.some((h) => h.url === (first?.kind === "page" ? first.url : "")), `${typed}: a visited row's URL is the exact URL of its history entry`);
  }
});

test("typing a complete address does not read the whole history again once it has been indexed", () => {
  const rowsOf = Array.from({ length: 400 }, (_, i) => ({ url: `https://site${i}.example/page`, title: `Site ${i}`, favicon: null, visits: 1, lastVisit: now - i * 1000 }));
  const saved = [{ url: "https://example.awsapps.com/start/#/console?a=1", title: "AWS access portal", favicon: null, visits: 4, lastVisit: now - 500 }, ...rowsOf];
  let reads = 0;
  const watched = new Proxy(saved, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const source = { tabs: [], history: watched, bookmarks: [] };
  const typed = (text: string) => buildSuggestions(text, source, { now }).items[0];
  const expected = { kind: "page", url: "https://example.awsapps.com/start/", title: "AWS access portal", favicon: null };
  assert.deepEqual(typed("https://example.awsapps.com/start/"), expected);
  reads = 0;
  assert.deepEqual(typed("https://example.awsapps.com/start/"), expected);
  assert.deepEqual(typed("example.awsapps.com/start/"), expected);
  assert.equal(reads, 0, "the second and third lookups read no history rows");
});

test("a typed address and the same page saved under a trailing slash are two choices", () => {
  const saved = [{ url: "https://a.com/page/", title: "Page", favicon: null, visits: 2, lastVisit: now - 1000 }];
  const { items } = buildSuggestions("https://a.com/page", { tabs: [], history: saved }, { now });
  assert.deepEqual(rows(items), ["https://a.com/page", "search:https://a.com/page", "https://a.com/page/"]);
  const [typedRow, , savedRow] = items;
  assert.equal(typedRow?.kind === "page" && typedRow.visited, undefined, "the typed row was never visited");
  assert.equal(savedRow?.kind === "page" && savedRow.visited, true, "the saved row keeps its history flag");
});

test("frecency: frequent + recent beats old, and multi-word queries match words", () => {
  const hist = [
    { url: "https://a.com/docs", title: "Rust docs", favicon: null, visits: 2, lastVisit: now - DAY * 60 },
    { url: "https://b.com/docs", title: "Rust docs", favicon: null, visits: 20, lastVisit: now - DAY },
  ];
  const { items } = buildSuggestions("docs rust", { tabs: [], history: hist }, { now });
  assert.deepEqual(rows(items), ["search:docs rust", "https://b.com/docs", "https://a.com/docs"]);
});

const google = engineById(BUILT_IN_ENGINES, "google");
const flush = () => new Promise((r) => setImmediate(r));

function fakeFetch(respond: (url: string) => unknown = (url) => [decodeURIComponent(url.split("q=").at(-1)!), ["a", "b"]]) {
  const calls: { url: string; signal: AbortSignal }[] = [];
  const fetch: FetchLike = (url, { signal }) => {
    calls.push({ url, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      queueMicrotask(() => resolve({ ok: true, text: async () => JSON.stringify(respond(url)) }));
    });
  };
  return { fetch, calls };
}

test("a newer request aborts the one in flight, which never answers", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { fetch, calls } = fakeFetch();
    const results: string[] = [];
    const fetcher = createSuggestFetcher({ fetch, delay: 10 });
    fetcher.request(google, "old", () => results.push("old"));
    mock.timers.tick(10);
    assert.equal(calls.length, 1);
    fetcher.request(google, "new", () => results.push("new"));
    assert.equal(calls[0]!.signal.aborted, true);
    mock.timers.tick(10);
    await flush();
    assert.deepEqual(results, ["new"]);
  } finally {
    mock.timers.reset();
  }
});


test("search first still completes a visited host inline, as Chrome does: 'you' gives youtube.com", () => {
  const hist = [
    { url: "https://www.youtube.com/watch?v=abc", title: "Video - YouTube", favicon: null, visits: 3, lastVisit: now - 1000 },
    { url: "https://www.youtube.com/", title: "YouTube", favicon: null, visits: 10, lastVisit: now - 1000 },
  ];
  const r = buildSuggestions("you", { tabs: [], history: hist }, { now, preference: "search" });
  assert.equal(r.completion, "tube.com");
  assert.equal(r.items[0]?.kind === "page" && r.items[0].url, "https://www.youtube.com/");
  assert.equal(buildSuggestions("youtube video", { tabs: [], history: hist }, { now, preference: "search" }).items[0]?.kind, "search");
  assert.equal(buildSuggestions("video", { tabs: [], history: hist }, { now, preference: "search" }).items[0]?.kind, "search");
});

const mapsReply = [
  "maps",
  ["maps google", "https://maps.google.com/", "maps directions", "2+2"],
  ["", "Google Maps", "", ""],
  [],
  { "google:suggesttype": ["QUERY", "NAVIGATION", "QUERY", "CALCULATOR"] },
];

test("Google's navigation suggestions become sites, and its queries stay searches", () => {
  assert.deepEqual(parseRemoteSuggestions(mapsReply), { queries: ["maps google", "maps directions"], sites: [{ url: "https://maps.google.com/", title: "Google Maps" }] });
  assert.deepEqual(parseSuggestions(mapsReply), ["maps google", "maps directions"]);
  const odd = ["x", ["javascript:alert(1)", "maps.google.com"], [], [], { "google:suggesttype": ["NAVIGATION", "NAVIGATION"] }];
  assert.deepEqual(parseRemoteSuggestions(odd).sites, [], "only http(s) addresses become sites");
});

test("'maps' offers Google Maps from the engine's navigation suggestion, with no history", () => {
  const { queries, sites } = parseRemoteSuggestions(mapsReply);
  const { items } = buildSuggestions("maps", { tabs: [], history: [] }, { now, remote: queries, remoteSites: sites });
  assert.equal(items[0]?.kind, "search", "Enter still searches");
  const row = items.find((i) => i.kind === "page");
  assert.deepEqual(row, { kind: "page", url: "https://maps.google.com/", title: "Google Maps", favicon: null });
  assert.ok(items.indexOf(row!) < items.findIndex((i) => i.kind === "search" && i.suggested), "the site sits above the suggested searches");
});

test("a navigation suggestion the history already has shows once, as the history row", () => {
  const hist = [{ url: "https://maps.google.com/", title: "Google Maps", favicon: "maps.ico", visits: 3, lastVisit: now - 1000 }];
  const { items } = buildSuggestions("maps", { tabs: [], history: hist }, { now, remote: [], remoteSites: [{ url: "https://maps.google.com/", title: "Google Maps" }] });
  assert.equal(items.filter((i) => i.kind === "page" && i.url === "https://maps.google.com/").length, 1);
});

test("the fetcher hands navigation suggestions over with the queries, also from its cache", async () => {
  const fetch: FetchLike = async () => ({ ok: true, text: async () => JSON.stringify(mapsReply) });
  const fetcher = createSuggestFetcher({ fetch, delay: 0 });
  const got: unknown[] = [];
  await new Promise<void>((resolve) => fetcher.request(google, "maps", (q, s) => (got.push([q, s]), resolve())));
  await new Promise<void>((resolve) => fetcher.request(google, "maps", (q, s) => (got.push([q, s]), resolve())));
  const expected = [["maps google", "maps directions"], [{ url: "https://maps.google.com/", title: "Google Maps" }]];
  assert.deepEqual(got, [expected, expected]);
});

test("a pasted address opens with the #fragment it carries, whatever fragment the saved page has", () => {
  const share = "https://excalidraw.com/#json=id,key";
  const saved = (url: string) => [{ url, title: "Excalidraw", favicon: "icon", visits: 4, lastVisit: now - 1000 }];
  for (const url of ["https://excalidraw.com/", "https://excalidraw.com", "https://excalidraw.com/#json=old,key", "https://excalidraw.com/#room=a"]) {
    const { items } = buildSuggestions(share, { tabs: [], history: saved(url) }, { now });
    assert.equal(items[0]?.kind === "page" && items[0].url, share, `saved ${url}: the first row opens the pasted address`);
    assert.equal(items[0]?.kind === "page" && items[0].title, "Excalidraw", `saved ${url}: the saved page lends its title`);
    assert.equal(items[0]?.kind === "page" && items[0].favicon, "icon", `saved ${url}: and its icon`);
  }
  const bookmarks = [{ url: "https://excalidraw.com/", title: "Excalidraw", favicon: null }];
  assert.equal(rows(buildSuggestions(share, { tabs: [], history: [], bookmarks }, { now }).items)[0], share, "a bookmarked page too");
  const tabs = [{ id: "t1", url: "https://excalidraw.com/", title: "Excalidraw", favicon: null }];
  assert.equal(rows(buildSuggestions(share, { tabs, history: [] }, { now }).items)[0], share, "a page open in a tab too");
});

test("a pasted address with a #fragment is not offered for removal from history unless that exact address is saved", () => {
  const share = "https://excalidraw.com/#json=id,key";
  const page = (url: string) => [{ url, title: "Excalidraw", favicon: null, visits: 4, lastVisit: now - 1000 }];
  const other = buildSuggestions(share, { tabs: [], history: page("https://excalidraw.com/") }, { now }).items[0];
  assert.equal(other?.kind === "page" && other.visited, undefined, "another address: no remove button that removes nothing");
  const same = buildSuggestions(share, { tabs: [], history: page(share) }, { now }).items[0];
  assert.equal(same?.kind === "page" && same.visited, true, "the same address: removable");
  assert.equal(same?.kind === "page" && same.url, share);
  const twice = [
    { url: "https://excalidraw.com/#json=old,key", title: "Old board", favicon: "old", visits: 4, lastVisit: now - 1000 },
    { url: share, title: "Shared board", favicon: "shared", visits: 1, lastVisit: now - 2000 },
  ];
  const later = buildSuggestions(share, { tabs: [], history: twice }, { now }).items[0];
  assert.equal(later?.kind === "page" && later.url, share, "saved under two fragments: opens the pasted one");
  assert.equal(later?.kind === "page" && later.visited, true, "the exact address is saved after another fragment of the page: still removable");
  assert.equal(later?.kind === "page" && later.title, "Shared board", "and lends its own title");
  assert.equal(later?.kind === "page" && later.favicon, "shared", "and its own icon");
});

test("a typed address opens the exact address that is saved, whatever other slash or #fragment forms of the page come first", () => {
  const saved = (url: string, title: string) => ({ url, title, favicon: null, visits: 2, lastVisit: now - 1000 });
  const first = (typed: string, history: ReturnType<typeof saved>[]) => buildSuggestions(typed, { tabs: [], history }, { now }).items[0];
  const board = "https://example.com/board";
  const plain = first(board, [saved(`${board}/`, "Board with slash"), saved(board, "Board")]);
  assert.equal(plain?.kind === "page" && plain.url, board, "the address without the slash opens without it");
  assert.equal(plain?.kind === "page" && plain.title, "Board", "and lends its own title");
  assert.equal(plain?.kind === "page" && plain.visited, true, "and stays removable");
  const room = first(`${board}#room`, [saved(`${board}/#room`, "Room with slash"), saved(`${board}#room`, "Room")]);
  assert.equal(room?.kind === "page" && room.url, `${board}#room`, "the same #fragment on the other slash form still opens the typed address");
  assert.equal(room?.kind === "page" && room.title, "Room", "and lends the exact row's title");
  assert.equal(room?.kind === "page" && room.visited, true, "and stays removable");
  const slashOnly = first(`${board}#room`, [saved(`${board}/#room`, "Room with slash")]);
  assert.equal(slashOnly?.kind === "page" && slashOnly.url, `${board}#room`, "no exact row: the typed address, not the saved slash form");
  assert.equal(slashOnly?.kind === "page" && slashOnly.visited, undefined, "and no remove button that removes nothing");
});

test("a typed address that is bookmarked as typed opens as typed with that bookmark's title, icon and flag", () => {
  const board = "https://example.com/board";
  const history = (url: string, title: string) => ({ url, title, favicon: null, visits: 2, lastVisit: now - 1000 });
  const bookmark = (url: string, title: string) => ({ url, title, favicon: "bookmark-icon" });
  const first = (typed: string, source: Parameters<typeof buildSuggestions>[1]) => buildSuggestions(typed, source, { now }).items[0];

  const slash = first(`${board}#room`, {
    tabs: [],
    history: [history(`${board}/#room`, "Room with slash"), history(`${board}#room`, "Room")],
    bookmarks: [bookmark(`${board}#room`, "Room bookmark")],
  });
  assert.equal(slash?.kind === "page" && slash.url, `${board}#room`, "the exact bookmarked address opens as typed");
  assert.equal(slash?.kind === "page" && slash.bookmarked, true, "and keeps its bookmark flag after another slash form in history");
  assert.equal(slash?.kind === "page" && slash.visited, true, "and stays removable");
  assert.equal(slash?.kind === "page" && slash.title, "Room", "and lends the exact history row's title");

  const bookmarkOnly = first(`${board}#new`, { tabs: [], history: [history(`${board}#old`, "Old board")], bookmarks: [bookmark(`${board}#new`, "New board")] });
  assert.equal(bookmarkOnly?.kind === "page" && bookmarkOnly.url, `${board}#new`, "pasting the bookmarked address opens it, not the history row under another fragment");
  assert.equal(bookmarkOnly?.kind === "page" && bookmarkOnly.title, "New board", "and lends the exact bookmark's title");
  assert.equal(bookmarkOnly?.kind === "page" && bookmarkOnly.favicon, "bookmark-icon", "and its icon");
  assert.equal(bookmarkOnly?.kind === "page" && bookmarkOnly.bookmarked, true, "and is classed as a bookmark");
  assert.equal(bookmarkOnly?.kind === "page" && bookmarkOnly.visited, undefined, "and no remove button, since no history row has that address");

  const unsaved = first(`${board}#fresh`, { tabs: [], history: [history(`${board}#old`, "Old board")], bookmarks: [bookmark(`${board}#new`, "New board")] });
  assert.equal(unsaved?.kind === "page" && unsaved.url, `${board}#fresh`, "an address saved under no fragment like it opens as typed");
  assert.equal(unsaved?.kind === "page" && unsaved.bookmarked, undefined, "and is not classed as a bookmark");
  assert.equal(unsaved?.kind === "page" && unsaved.visited, undefined, "nor as history");
});


test("each new path tags its row, so the bar can report which path a pick came from", () => {
  const viaOf = (r: ReturnType<typeof buildSuggestions>) => Object.fromEntries(Object.entries(r.via ?? {}).map(([key, v]) => [key.split(":")[0] + ":" + v, true]));
  const saved = [{ url: "https://excalidraw.com/", title: "Excalidraw", favicon: null, visits: 4, lastVisit: now - 1000 }];
  const literal = buildSuggestions("https://excalidraw.com/#json=a,b", { tabs: [], history: saved }, { now });
  assert.equal(literal.via?.[suggestionKey(literal.items[0]!)], "literal", "a typed address kept instead of a saved variant");
  assert.equal(buildSuggestions("https://excalidraw.com/", { tabs: [], history: saved }, { now }).via, undefined, "the exact saved address is no new path");
  const tab = { id: "t7", url: "https://linear.app/team/board", title: "Linear – Issues", customTitle: "Work board", favicon: null };
  const renamed = buildSuggestions("work board", { tabs: [tab], history }, { now });
  assert.deepEqual(viaOf(renamed), { "tab:renamed_tab": true });
  assert.equal(buildSuggestions("linear", { tabs: [{ ...tab, customTitle: null }], history }, { now }).via, undefined, "a tab with no custom title");
  const site = buildSuggestions("maps", { tabs: [], history: [] }, { now, remoteSites: [{ url: "https://maps.google.com/", title: "Google Maps" }] });
  assert.deepEqual(viaOf(site), { "page:engine_site": true });
  const yt = [{ url: "https://www.youtube.com/", title: "YouTube", favicon: null, visits: 5, lastVisit: now - 1000 }];
  const searchFirst = buildSuggestions("you", { tabs: [], history: yt }, { now, preference: "search" });
  assert.equal(searchFirst.via?.[suggestionKey(searchFirst.items[0]!)], "search_first_inline");
  assert.equal(buildSuggestions("you", { tabs: [], history: yt }, { now }).via, undefined, "website first completes as it always did");
  for (const r of [literal, renamed, site, searchFirst]) for (const key of Object.keys(r.via ?? {})) assert.ok(r.items.some((x) => suggestionKey(x) === key), key);
});
