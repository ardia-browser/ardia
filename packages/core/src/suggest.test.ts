import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BUILT_IN_ENGINES, engineById, parseRemoteSuggestions, parseSuggestions } from "./engines.ts";
import { buildSuggestions, listsRoutesApart, suggestionKey, type Suggestion } from "./suggest.ts";
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

test("a bookmark's name labels only the row that opens the bookmark's own address, and still finds the page open in a renamed tab", () => {
  const base = "https://app.example.org/";
  const visited = [...history, { url: `${base}#/a`, title: "Dashboard", favicon: null, visits: 3, lastVisit: now - 9000 }];
  const rowsFor = (q: string) => buildSuggestions(q, { tabs: [], history: visited, bookmarks: [{ url: `${base}#/b`, title: "All Embeddables", favicon: null }] }, { now }).items.filter((i) => i.kind === "page");
  assert.ok(!rowsFor("all embe").some((i) => i.kind === "page" && i.title === "All Embeddables" && i.url !== `${base}#/b`), "no row named after #/b opens #/a");
  assert.equal(rowsFor("dashboard")[0]?.kind === "page" && rowsFor("dashboard")[0]?.title, "Dashboard");
  const url = "https://app.example.org/d/42";
  const source = { tabs: [{ id: "t1", url, title: "Builder Dashboard", favicon: null, customTitle: "Work board" }], history: [...history, { url, title: "Builder Dashboard", favicon: null, visits: 3, lastVisit: now - 9000 }], bookmarks: [{ url, title: "All Embeddables", favicon: null }] };
  const found = buildSuggestions("all embe", source, { now }).items.find((i) => i.kind === "page");
  assert.equal(found?.kind === "page" && found.tabId, "t1", "the renamed tab is found by the bookmark's name");
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
  assert.deepEqual(firstRow(other, { tabs: [], history: hist }), { kind: "page", url: other, title: "", favicon: null }, "another typed route is its own page: it borrows nothing from the saved one");
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
  assert.deepEqual(first("https://a.com/#/c", [{ url: "https://a.com/#/b", title: "B", favicon: null }]), { kind: "page", url: "https://a.com/#/c", title: "", favicon: null }, "a route nothing saved has its own title and icon: not another route's");
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

const roam = (route: string) => `https://roamresearch.com/#/app/${route}`;
const roamHistory = [
  { url: roam("graph3333"), title: "graph3333", favicon: "g3.ico", visits: 6, lastVisit: now - 1000 },
  { url: roam("graph4444"), title: "graph4444", favicon: "g4.ico", visits: 2, lastVisit: now - 2000 },
];
const roamBookmarks = [{ url: roam("graph5555"), title: "graph5555", favicon: null }];
const roamPins = [
  { id: "t1", url: roam("graph1111"), title: "graph1111", favicon: "g1.ico" },
  { id: "t2", url: roam("graph2222"), title: "graph2222", favicon: "g2.ico" },
];

test("each route of a hash-routed site is its own page: every pinned, saved and bookmarked one is listed", () => {
  const source = { tabs: roamPins, history: roamHistory, bookmarks: roamBookmarks };
  const listed = rows(buildSuggestions("roamresearch.com", source, { now }).items);
  for (const graph of ["graph1111", "graph2222"]) assert.ok(listed.includes(`tab:${roam(graph)}`), `${graph}: its own Switch to Tab row, got ${listed.join(" | ")}`);
  for (const graph of ["graph3333", "graph4444", "graph5555"]) assert.ok(listed.includes(roam(graph)), `${graph}: its own saved row, got ${listed.join(" | ")}`);
  const typed = rows(buildSuggestions("roamresearch.com/#/app/graph2222", source, { now }).items);
  assert.deepEqual(typed, [roam("graph2222"), "search:roamresearch.com/#/app/graph2222", `tab:${roam("graph2222")}`], "a typed route lists only its own tab");
});

test("a typed route of a hash-routed site opens as typed, whichever other routes are pinned or saved", () => {
  const help = roam("help");
  const source = { tabs: roamPins, history: roamHistory, bookmarks: roamBookmarks };
  for (const typed of [help, "roamresearch.com/#/app/help"]) {
    const { items } = buildSuggestions(typed, source, { now });
    assert.deepEqual(items[0], { kind: "page", url: help, title: "", favicon: null }, `${typed}: a plain row for what was typed, no title, icon or tab borrowed from another route`);
    assert.equal(items.filter((i) => i.kind === "page" && i.tabId !== undefined).length, 0, `${typed}: nothing to switch to, the pins are other pages`);
    assert.deepEqual(buildSuggestions(typed, source, { now, switchToOpenTab: true }).items[0], { kind: "page", url: help, title: "", favicon: null }, `${typed}: ⌘T opens it instead of switching to another route's pin`);
  }
  const switched = buildSuggestions(roam("graph1111"), source, { now, switchToOpenTab: true }).items[0];
  assert.equal(switched?.kind === "page" && switched.tabId, "t1", "⌘T on a pinned route still switches to its pin");
  const editing = buildSuggestions(help, source, { now, currentTabId: "t1", currentUrl: roam("graph1111") });
  assert.deepEqual(editing.items[0], { kind: "page", url: help, title: "", favicon: null }, "editing the current tab's address");
  assert.deepEqual(rows(buildSuggestions("roamresearch.com", { ...source, tabs: roamPins.slice(1) }, { now, currentTabId: "t1", currentUrl: roam("graph1111") }).items).filter((r) => r.startsWith("tab:")), [`tab:${roam("graph2222")}`], "the other pin stays a choice");
  const pinned = buildSuggestions(roam("graph1111"), source, { now }).items;
  assert.deepEqual(rows(pinned).slice(0, 3), [roam("graph1111"), `search:${roam("graph1111")}`, `tab:${roam("graph1111")}`], "a typed route that is pinned still lists its Switch to Tab row");
  assert.equal(pinned[0]?.kind === "page" && pinned[0].tabId, undefined, "and the typed row only opens it");
});

test("a #! route is a page of its own too, while an anchor is not: #grid and #top are one page", () => {
  const hist = [
    { url: "https://a.com/#!/x", title: "X", favicon: null, visits: 3, lastVisit: now - 1000 },
    { url: "https://a.com/#!/y", title: "Y", favicon: null, visits: 2, lastVisit: now - 2000 },
    { url: "https://b.com/#grid", title: "Grid", favicon: null, visits: 3, lastVisit: now - 1000 },
    { url: "https://b.com/#top", title: "Top", favicon: null, visits: 2, lastVisit: now - 2000 },
  ];
  const saved = (typed: string) => rows(buildSuggestions(typed, { tabs: [], history: hist }, { now }).items).filter((r) => r.includes("#"));
  assert.deepEqual(saved("a.com"), ["https://a.com/#!/x", "https://a.com/#!/y"]);
  assert.deepEqual(saved("b.com"), ["https://b.com/#grid"], "an anchor never made the page a different one");
});

test("listsRoutesApart tells a list that shows several routes of one page from one that shows a single route", () => {
  const source = { tabs: roamPins, history: roamHistory, bookmarks: roamBookmarks };
  assert.equal(listsRoutesApart(buildSuggestions("roamresearch.com", source, { now }).items), true, "every route of the site is its own row");
  assert.equal(listsRoutesApart(buildSuggestions("roamresearch.com", { tabs: roamPins.slice(0, 1), history: [], bookmarks: [] }, { now }).items), false, "one route is one row");
  assert.equal(listsRoutesApart(buildSuggestions("roamresearch.com/#/app/graph2222", source, { now }).items), false, "a typed route lists only its own page");
  const anchors = [{ url: "https://b.com/#grid", title: "Grid", favicon: null, visits: 3, lastVisit: now - 1000 }, { url: "https://b.com/#top", title: "Top", favicon: null, visits: 2, lastVisit: now - 2000 }];
  assert.equal(listsRoutesApart(buildSuggestions("b.com", { tabs: [], history: anchors }, { now }).items), false, "an anchor is not a route");
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

test("a spaced address that could be prose searches first, with its escaped URL right after", () => {
  const { items, via } = buildSuggestions("asp.net/core vs django", { tabs: [], history: [] }, { now });
  assert.equal(items[0]?.kind, "search");
  assert.deepEqual(items[1], { kind: "page", url: "https://asp.net/core%20vs%20django", title: "", favicon: null });
  assert.equal(via?.[suggestionKey(items[1]!)], "spaced_address");
  const wiki = buildSuggestions("en.wikipedia.org/wiki/Jim Beam", { tabs: [], history: [] }, { now }).items;
  assert.deepEqual(wiki[0], { kind: "page", url: "https://en.wikipedia.org/wiki/Jim%20Beam", title: "", favicon: null });
  assert.equal(wiki.filter((i) => i.kind === "page").length, 1);
});

test("the escaped address offered below a spaced search is the open tab when one shows it, and keeps its own telemetry tag", () => {
  const url = "https://example.com/My%20Folder/index.html";
  const tab = { id: "t9", url, title: "My Folder", customTitle: null, favicon: null };
  const { items } = buildSuggestions("example.com/My Folder/index.html", { tabs: [tab], history: [] }, { now, limit: 2 });
  assert.equal(items[0]?.kind, "search");
  assert.equal(items[1]?.kind === "page" && items[1].tabId, "t9");
  assert.equal(buildSuggestions("example.com/My Folder/index.html", { tabs: [tab], history: [] }, { now }).items.filter((i) => i.kind === "page" && i.url === url).length, 1);
  const sites = buildSuggestions("example.com/My Folder/index.html", { tabs: [], history: [] }, { now, remoteSites: [{ url, title: "My Folder" }] });
  const guess = sites.items.find((i) => i.kind === "page" && i.url === url);
  assert.equal(sites.via?.[suggestionKey(guess!)], "spaced_address");
});

test("a saved page can't outrank the search for a spaced address that could be prose", () => {
  const history = [{ url: "https://asp.net/wiki/discussion", title: "asp.net/wiki/Core vs Django discussion", favicon: null, visits: 40, lastVisit: now - 1000 }];
  const { items } = buildSuggestions("asp.net/wiki/Core vs Django", { tabs: [], history }, { now, limit: 2 });
  assert.equal(items[0]?.kind, "search");
  assert.equal(items[1]?.kind === "page" && items[1].url, "https://asp.net/wiki/Core%20vs%20Django");
});

test("the escaped row switches only to a tab at exactly that address, whatever the host's case", () => {
  const url = "https://example.com/My%20Folder/index.html";
  const history = [{ url, title: "My Folder", favicon: null, visits: 3, lastVisit: now - 1000 }];
  const elsewhere = { id: "t1", url: `${url}#tail`, title: "My Folder", customTitle: null, favicon: null };
  const guess = (text: string, tabs: { id: string; url: string; title: string; customTitle: null; favicon: null }[]) => buildSuggestions(text, { tabs, history }, { now, limit: 2 }).items[1];
  const fragment = guess("example.com/My Folder/index.html", [elsewhere]);
  assert.equal(fragment?.kind === "page" && fragment.url, url);
  assert.equal(fragment?.kind === "page" && fragment.tabId, undefined);
  const exact = { id: "t2", url, title: "My Folder", customTitle: null, favicon: null };
  const upper = guess("EXAMPLE.com/My Folder/index.html", [exact]);
  assert.equal(upper?.kind === "page" && upper.tabId, "t2");
});

test("the escaped row appears once beside a matching open tab and site suggestion, and keeps its telemetry tag", () => {
  const url = "https://example.com/My%20Folder/index.html";
  const tab = { id: "t3", url, title: "My Folder", customTitle: "Renamed", favicon: null };
  const history = [{ url, title: "My Folder", favicon: null, visits: 2, lastVisit: now - 1000 }];
  const result = buildSuggestions("example.com/My Folder/index.html", { tabs: [tab], history }, { now, remoteSites: [{ url, title: "My Folder" }] });
  const rows = result.items.filter((i) => i.kind === "page" && i.url === url);
  assert.equal(rows.length, 1);
  assert.equal(result.via?.[suggestionKey(rows[0]!)], "spaced_address");
});

test("the escaped row treats a default port, a missing root slash and host case as the same address", () => {
  const tabAt = (id: string, url: string) => ({ id, url, title: "Open", customTitle: null, favicon: null });
  const pages = (text: string, tabs: ReturnType<typeof tabAt>[], history: { url: string; title: string; favicon: null; visits: number; lastVisit: number }[] = []) => buildSuggestions(text, { tabs, history }, { now }).items.filter((i) => i.kind === "page");
  const chapter = pages("example.com#Chapter 2", [tabAt("t4", "https://example.com/#Chapter%202")]);
  assert.deepEqual(chapter.map((i) => i.kind === "page" && i.tabId), ["t4"]);
  const port = pages("example.com:443/My Folder/index.html", [tabAt("t5", "https://example.com/My%20Folder/index.html")]);
  assert.deepEqual(port.map((i) => i.kind === "page" && i.tabId), ["t5"]);
  const history = [{ url: "https://EXAMPLE.com/My%20Folder/index.html", title: "My Folder", favicon: null, visits: 4, lastVisit: now - 1000 }];
  const cased = pages("example.com/My Folder/index.html", [tabAt("t6", "https://example.com/My%20Folder/index.html")], history);
  assert.deepEqual(cased.map((i) => i.kind === "page" && i.tabId), ["t6"]);
});

test("the escaped row leaves a tab open at another fragment alone, borrows a saved row's title, and reads a zero-padded default port", () => {
  const url = "https://example.com/My%20Folder/index.html";
  const tab = (id: string, at: string) => ({ id, url: at, title: "Open", customTitle: null, favicon: null });
  const saved = (at: string) => [{ url: at, title: "My Folder", favicon: "f.ico", visits: 4, lastVisit: now - 1000 }];
  const pages = (text: string, tabs: ReturnType<typeof tab>[], history: ReturnType<typeof saved>) => buildSuggestions(text, { tabs, history }, { now }).items.filter((i) => i.kind === "page");
  const tail = pages("example.com/My Folder/index.html", [tab("t7", `${url}#tail`)], saved(url));
  assert.ok(tail.some((i) => i.kind === "page" && i.tabId === "t7" && i.url === `${url}#tail`), "the tab at #tail is still offered, at its own address");
  assert.ok(tail.some((i) => i.kind === "page" && i.url === url && !i.tabId), "and so is the exact address");
  const titled = pages("example.com/My Folder/index.html", [], saved("https://EXAMPLE.com/My%20Folder/index.html"));
  assert.equal(titled.length, 1);
  assert.equal(titled[0]?.kind === "page" && titled[0].title, "My Folder");
  assert.equal(titled[0]?.kind === "page" && titled[0].url, url, "it still opens the escaped address");
  const padded = pages("example.com:00443/My Folder/index.html", [tab("t8", url)], []);
  assert.deepEqual(padded.map((i) => i.kind === "page" && i.tabId), ["t8"]);
});

test("the escaped row finds a tab open at the punycode form of a Unicode host", () => {
  const tab = { id: "t9", url: "https://xn--bcher-kva.de/My%20Folder/index.html", title: "Bücher", customTitle: null, favicon: null };
  const pages = buildSuggestions("bücher.de/My Folder/index.html", { tabs: [tab], history: [] }, { now }).items.filter((i) => i.kind === "page");
  assert.deepEqual(pages.map((i) => i.kind === "page" && i.tabId), ["t9"]);
});

test("in a bar that opens a new tab, an address another tab has open switches to that tab first", () => {
  const url = "https://mail.example.com/";
  const opts = { now, switchToOpenTab: true };
  const tabs = [{ id: "mail", url: `${url}#inbox`, title: "Inbox", favicon: null }];
  const visited = [...history, { url, title: "Inbox", favicon: null, visits: 9, lastVisit: now - 1000 }];
  for (const typed of ["mail.ex", "mail.example.com", "https://mail.example.com", "mail.example.com/"]) {
    const r = buildSuggestions(typed, { tabs, history: visited }, opts);
    assert.equal(r.items[0]?.kind === "page" && r.items[0].tabId, "mail", typed);
    assert.equal(r.via?.[suggestionKey(r.items[0]!)], "open_tab", typed);
    assert.equal(rows(r.items).filter((x) => /^(tab:)?https:\/\/mail\.example\.com/.test(x)).length, 1, `${typed}: listed once`);
  }
  assert.equal(buildSuggestions("mail.ex", { tabs, history: visited }, opts).completion, "ample.com", "the completion stays");
  for (const typed of ["https://MAIL.Example.COM/", "MAIL.EXAMPLE.COM"]) {
    const upper = buildSuggestions(typed, { tabs, history }, opts);
    assert.equal(upper.items[0]?.kind === "page" && upper.items[0].tabId, "mail", `${typed}: the host's case doesn't matter`);
  }
  const own = buildSuggestions("mail.example.com", { tabs, history: visited }, { ...opts, currentTabId: "mail" });
  assert.equal(rows(own.items)[0], url, "the bar's own tab is never offered as a switch");
  const unvisited = buildSuggestions("mail.example.com", { tabs, history }, opts);
  assert.equal(unvisited.items[0]?.kind === "page" && unvisited.items[0].tabId, "mail", "a tab with no history row switches too");
  const elsewhere = [{ id: "deep", url: "https://mail.example.com/settings", title: "Settings", favicon: null }];
  assert.equal(rows(buildSuggestions("mail.example.com", { tabs: elsewhere, history: visited }, opts).items)[0], url, "a tab at another page of the site doesn't take the typed address");
  const addressBar = rows(buildSuggestions("mail.example.com", { tabs, history: visited }, { now }).items);
  assert.equal(addressBar[0], url, "the address bar still opens what was typed");
  assert.ok(addressBar.indexOf(`tab:${url}`) > 0 && addressBar.indexOf(`tab:${url}`) < 4, "with Switch to Tab right below");
});

const SPRINT_REMOTE = ["sprint board template", "sprint board app", "sprint board online", "sprint board ideas"];

test("open tabs that match as well as the third page row are listed before the remote suggestions", () => {
  const teams = ["Alpha", "Beta", "Gamma", "Delta"];
  const url = (t: string) => `https://${t.toLowerCase()}.example.com/board`;
  const visited = teams.map((t, i) => ({ url: url(t), title: "Board - Tracker", favicon: null, visits: 40 - i * 10, lastVisit: now - 1000 }));
  const tabs = teams.map((t) => ({ id: `t-${t}`, url: url(t), title: "Board - Tracker", favicon: null, customTitle: `Sprint Board (${t})` }));
  for (const preference of ["search", "website"] as const) {
    const r = buildSuggestions("sprint board", { tabs, history: visited }, { now, preference, remote: SPRINT_REMOTE });
    const listed = rows(r.items);
    const firstRemote = listed.findIndex((x) => x.startsWith("suggest:"));
    assert.ok(firstRemote > 0, `${preference}: remote suggestions still listed`);
    for (const t of teams) {
      const at = listed.indexOf(`tab:${url(t)}`);
      assert.ok(at >= 0 && at < firstRemote, `${preference}: ${t} sits above the remote suggestions: ${listed.join(", ")}`);
    }
    const delta = r.items.find((x) => x.kind === "page" && x.tabId === "t-Delta")!;
    assert.equal(r.via?.[suggestionKey(delta)], "leading_tab", `${preference}: the lifted tab is tagged`);
  }
  const broad = rows(buildSuggestions("a", { tabs, history: visited }, { now, preference: "search", remote: ["amazon", "apple", "airbnb", "aws"] }).items);
  assert.ok(broad.some((x) => x.startsWith("suggest:")), "a broad query keeps its remote suggestions");
});

test("a quiet open tab that matches best isn't pushed out by busier pages that match less well", () => {
  const busy = Array.from({ length: 12 }, (_, i) => ({ url: `https://boards.example.com/item-${i}`, title: `sprint item ${i} board`, favicon: null, visits: 400, lastVisit: now - 1000 }));
  const quiet = "https://boards.example.com/team/delta";
  const visited = [...busy, { url: quiet, title: "Delta board", favicon: null, visits: 1, lastVisit: now - DAY * 20 }];
  const tabs = [{ id: "t-delta", url: quiet, title: "Delta board", favicon: null, customTitle: "Sprint Board (Delta)" }];
  const listed = rows(buildSuggestions("sprint board", { tabs, history: visited }, { now, preference: "search", remote: SPRINT_REMOTE }).items);
  const at = listed.indexOf(`tab:${quiet}`);
  assert.ok(at >= 0, `the renamed tab is listed: ${listed.join(", ")}`);
  assert.ok(at < listed.findIndex((x) => x.startsWith("suggest:")), "above the remote suggestions");
});

test("two renamed tabs on one page take one leading slot, so a third matching tab still comes before the remote suggestions", () => {
  const url = (p: string) => `https://boards.example.com/${p}`;
  const visited = ["a", "b", "c"].map((p, i) => ({ url: url(p), title: `Sprint board ${p}`, favicon: null, visits: 50 - i, lastVisit: now - 1000 }));
  const tabs = [
    { id: "dup-1", url: url("team"), title: "Team", favicon: null, customTitle: "Sprint board one" },
    { id: "dup-2", url: url("team"), title: "Team", favicon: null, customTitle: "Sprint board two" },
    { id: "other", url: url("other"), title: "Other", favicon: null, customTitle: "Sprint board three" },
  ];
  const listed = rows(buildSuggestions("sprint board", { tabs, history: visited }, { now, preference: "search", remote: SPRINT_REMOTE }).items);
  const firstRemote = listed.findIndex((x) => x.startsWith("suggest:"));
  assert.ok(listed.indexOf(`tab:${url("other")}`) >= 0 && listed.indexOf(`tab:${url("other")}`) < firstRemote, listed.join(", "));
});

test("a typed address switched to keeps its open_tab tag and the address as typed, even with a renamed tab on it", () => {
  const tabs = [{ id: "t1", url: "https://example.com/#old", title: "Example", favicon: null, customTitle: "My example" }];
  const visited = [...history, { url: "https://example.com/", title: "Example", favicon: null, visits: 3, lastVisit: now - 1000 }];
  const r = buildSuggestions("https://example.com/#new", { tabs, history: visited }, { now, switchToOpenTab: true });
  assert.equal(r.items[0]?.kind === "page" && r.items[0].tabId, "t1");
  assert.equal(r.items[0]?.kind === "page" && r.items[0].url, "https://example.com/#new");
  assert.equal(r.via?.[suggestionKey(r.items[0]!)], "open_tab");
});

test("three renamed tabs on one page take one of the first three slots, so four other matching tabs still lead", () => {
  const url = (p: string) => `https://boards.example.com/${p}`;
  const tabs = [
    ...["one", "two", "three"].map((n) => ({ id: `dup-${n}`, url: url("team"), title: "Team", favicon: null, customTitle: `Sprint board ${n}` })),
    ...["w", "x", "y", "z"].map((p) => ({ id: `t-${p}`, url: url(p), title: p, favicon: null, customTitle: `Sprint board ${p}` })),
  ];
  const listed = rows(buildSuggestions("sprint board", { tabs, history }, { now, preference: "search", remote: SPRINT_REMOTE }).items);
  const firstRemote = listed.findIndex((x) => x.startsWith("suggest:"));
  const leading = listed.slice(0, firstRemote).filter((x) => x.startsWith("tab:"));
  assert.equal(new Set(leading).size, leading.length);
  assert.equal(leading.length, 5, listed.join(", "));
});

test("many renamed tabs on one page take one ranking slot, so stronger pages and the leading bar stay as they are", () => {
  const url = (p: string) => `https://boards.example.com/${p}`;
  const visited = [...["a", "b"].map((p) => ({ url: url(p), title: `Sprint board ${p}`, favicon: null, visits: 1, lastVisit: now - 1000 })), { url: url("team"), title: "Team", favicon: null, visits: 900, lastVisit: now - 1000 }];
  const tabs = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `dup-${i}`, url: url("team"), title: "Team", favicon: null, customTitle: `Sprint board copy ${i}` })),
    { id: "weak", url: url("weak"), title: "Weak", favicon: null, customTitle: "board sprint notes" },
  ];
  const listed = rows(buildSuggestions("sprint board", { tabs, history: visited }, { now, preference: "search", remote: SPRINT_REMOTE }).items);
  assert.ok(listed.includes(url("a")) && listed.includes(url("b")), listed.join(", "));
  const firstRemote = listed.findIndex((x) => x.startsWith("suggest:"));
  const weak = listed.indexOf(`tab:${url("weak")}`);
  assert.ok(weak < 0 || weak > firstRemote, `a tab that matches less well than the third row stays below the suggestions: ${listed.join(", ")}`);
});

test("a typed address switches only to a tab at that same path, and the tab is listed once", () => {
  const opts = { now, switchToOpenTab: true };
  const slashTab = [{ id: "t1", url: "https://example.com/page/", title: "Page", favicon: null }];
  const typedPage = buildSuggestions("https://example.com/page", { tabs: slashTab, history }, opts);
  assert.notEqual(typedPage.items[0]?.kind === "page" && typedPage.items[0].tabId, "t1", "a tab at /page/ doesn't take a typed /page");
  const tabs = [{ id: "t2", url: "https://example.com/", title: "Example", favicon: null }];
  const visited = [...history, { url: "https://example.com/", title: "Example", favicon: null, visits: 3, lastVisit: now - 1000 }];
  for (const typed of ["EXAMPLE.COM", "https://Example.com/", "exam"]) {
    const listed = buildSuggestions(typed, { tabs, history: visited }, opts).items.filter((i) => i.kind === "page" && i.tabId === "t2");
    assert.equal(listed.length, 1, `${typed}: ${JSON.stringify(listed)}`);
  }
});

test("a typed address finds the tab at exactly that address even when another tab shares its page, and its flags are the typed address's own", () => {
  const opts = { now, switchToOpenTab: true };
  const tabs = [
    { id: "slash", url: "https://example.com/page/", title: "Page", favicon: null },
    { id: "exact", url: "https://example.com/page", title: "Page", favicon: null },
  ];
  const r = buildSuggestions("https://example.com/page", { tabs, history }, opts);
  assert.equal(r.items[0]?.kind === "page" && r.items[0].tabId, "exact");
  const saved = { tabs: [{ id: "t1", url: "https://example.com/#old", title: "Example", favicon: null }], history: [...history, { url: "https://example.com/", title: "Example", favicon: null, visits: 3, lastVisit: now - 1000 }], bookmarks: [{ url: "https://example.com/", title: "Example", favicon: null }] };
  const fresh = buildSuggestions("https://example.com/#new", saved, opts).items[0];
  assert.deepEqual(fresh?.kind === "page" && [fresh.tabId, fresh.url, fresh.visited ?? false, fresh.bookmarked ?? false], ["t1", "https://example.com/#new", false, false]);
  const plain = buildSuggestions("https://example.com/", saved, opts).items[0];
  assert.deepEqual(plain?.kind === "page" && [plain.tabId, plain.visited ?? false, plain.bookmarked ?? false], ["t1", true, true]);
});

test("a typed address switched to shows its own title, or the tab's custom name, not another fragment's", () => {
  const opts = { now, switchToOpenTab: true };
  const visited = [...history, { url: "https://a.example.com/#/a", title: "Page A", favicon: "a.ico", visits: 9, lastVisit: now - 1000 }, { url: "https://a.example.com/#/b", title: "Page B", favicon: "b.ico", visits: 1, lastVisit: now - 9000 }];
  const tab = { id: "tb", url: "https://a.example.com/#/b", title: "Page B (live)", favicon: null };
  const row = buildSuggestions("https://a.example.com/#/b", { tabs: [tab], history: visited }, opts).items[0];
  assert.deepEqual(row?.kind === "page" && [row.tabId, row.title, row.favicon], ["tb", "Page B", "b.ico"]);
  const renamed = buildSuggestions("https://a.example.com/#/b", { tabs: [{ ...tab, customTitle: "My board" }], history: visited }, opts).items[0];
  assert.equal(renamed?.kind === "page" && renamed.title, "My board");
});

const PAGES_THEN_REMOTE = Array.from({ length: 8 }, (_, i) => ({ url: `https://docs.example.com/react-${i}`, title: `React guide ${i}`, favicon: null, visits: 30 - i, lastVisit: now - 1000 }));

test("rows shown while search suggestions are on their way stay where they are when the suggestions land", () => {
  const remote = ["react hooks", "react router", "react native", "react query"];
  for (const preference of ["search", "website"] as const) {
    const waiting = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, preference, remotePending: true }).items);
    const landed = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, preference, remote }).items);
    assert.deepEqual(landed.slice(0, waiting.length), waiting, `${preference}: ${waiting.join(", ")} → ${landed.join(", ")}`);
    assert.ok(landed.some((x) => x.startsWith("suggest:")), `${preference}: the suggestions are listed below`);
  }
  const none = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, remote: [] }).items);
  const waiting = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, remotePending: true }).items);
  assert.deepEqual(none.slice(0, waiting.length), waiting, "an empty answer only adds rows below");
  assert.ok(none.length > waiting.length, "and fills the list once it is in");
});

test("a request that fails says so, so the bar stops waiting for it", async () => {
  const fetch: FetchLike = async () => {
    throw new Error("suggestion request stopped");
  };
  const fetcher = createSuggestFetcher({ fetch, delay: 0 });
  const got = await new Promise<string>((resolve) => fetcher.request(google, "maps", () => resolve("result"), () => resolve("failed")));
  assert.equal(got, "failed");
});

test("in a site scope, its pages wait below the suggestions too", () => {
  const scope = { kind: "site" as const, name: "Docs", host: "docs.example.com", url: "https://docs.example.com/search?q=%s" };
  const remote = ["react hooks", "react router"];
  const waiting = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, scope, remotePending: true }).items);
  const landed = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, scope, remote }).items);
  assert.deepEqual(landed.slice(0, waiting.length), waiting);
  assert.ok(landed.some((x) => x.startsWith("https://docs.example.com/react")), "its pages come in below");
});

test("a provider row shown while suggestions are on their way stays when the held history rows come in", () => {
  const providers = [{ id: "docs", title: "Docs", rows: [{ title: "React guide 6 (Docs)", url: "https://docs.example.com/react-6" }] }];
  const waiting = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, remotePending: true, providers }).items);
  const landed = rows(buildSuggestions("react", { tabs: [], history: PAGES_THEN_REMOTE }, { now, remote: [], providers }).items);
  assert.deepEqual(landed.slice(0, waiting.length), waiting, `${waiting.join(", ")} → ${landed.join(", ")}`);
});

test("an open tab further down keeps its Switch to Tab row over a provider row for the same page, before and after the suggestions land", () => {
  const providers = [{ id: "docs", title: "Docs", rows: [{ title: "React guide 6 (Docs)", url: "https://docs.example.com/react-6" }] }];
  const tabs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `t${i}`, url: `https://docs.example.com/react-${i}`, title: `React guide ${i}`, favicon: null }));
  for (const options of [{ remotePending: true }, { remote: [] }]) {
    const listed = rows(buildSuggestions("react", { tabs, history: PAGES_THEN_REMOTE }, { now, limit: 12, providers, ...options }).items);
    assert.ok(!listed.some((x) => x.startsWith("provider:")), listed.join(", "));
    if (!options.remotePending) assert.ok(listed.includes("tab:https://docs.example.com/react-6"), listed.join(", "));
  }
});

test("a tab row replaced in the same list is seen on the next key, also for a spaced address", () => {
  const tabs: { id: string; url: string; title: string; favicon: null }[] = [{ id: "t1", url: "https://example.com/my%20page", title: "Mine", favicon: null }];
  const source = { tabs, history };
  for (const q of ["example.com/my page", "example.com/my pag"]) buildSuggestions(q, source, { now });
  tabs[0] = { ...tabs[0]!, url: "https://example.com/my%20page#new" };
  const fresh = buildSuggestions("example.com/my page", { tabs: [...tabs], history }, { now });
  assert.deepEqual(buildSuggestions("example.com/my page", source, { now }), fresh);
});

test("a spaced address reads a tab's current address even when the same tab row object changes", () => {
  const row = { id: "t1", url: "https://example.com/my%20page#old", title: "Mine", favicon: null };
  const source = { tabs: [row], history };
  buildSuggestions("example.com/my pag", source, { now });
  row.url = "https://example.com/my%20page#new";
  const urls = buildSuggestions("example.com/my pag", source, { now }).items.flatMap((i) => (i.kind === "page" && i.tabId === "t1" ? [i.url] : []));
  assert.ok(urls.length > 0, "the tab's row is listed");
  assert.ok(urls.every((u) => u === row.url), urls.join(", "));
});
