import assert from "node:assert/strict";
import { test } from "node:test";
import { allEngines, BUILT_IN_ENGINES } from "./engines.ts";
import { asksForBackspace, keywordBySpace, offeredSiteSearch, siteSearchKey, type SearchScope, type SiteSearchKeyState } from "./siteSearch.ts";

const sources = { engines: BUILT_IN_ENGINES };

function bar(typed: string, completion = "", scope: SearchScope | null = null, scopeFrom = ""): SiteSearchKeyState {
  return { typed, completion, scope, offered: scope ? null : offeredSiteSearch(typed, completion, sources), scopeFrom };
}

test("Tab enters site search while inline completion is showing: 'google' + '.com'", () => {
  const state = bar("google", ".com");
  assert.equal(state.offered?.name, "Google");
  const action = siteSearchKey("Tab", {}, state);
  assert.equal(action?.kind, "enter");
  assert.equal(action?.kind === "enter" && action.scope.name, "Google");
  assert.equal(action?.kind === "enter" && action.from, "google.com");
});

test("Tab enters site search from a short prefix the completion finishes: 'goo' + 'gle.com'", () => {
  const action = siteSearchKey("Tab", {}, bar("goo", "gle.com"));
  assert.deepEqual(action?.kind === "enter" && [action.scope.name, action.from], ["Google", "goo" + "gle.com"]);
});

test("Tab enters site search for a typed site with no completion: 'x.com'", () => {
  const action = siteSearchKey("Tab", {}, bar("x.com"));
  assert.deepEqual(action?.kind === "enter" && [action.scope.kind, action.scope.name, action.from], ["site", "X", "x.com"]);
});

test("Tab enters a Google site's search from its one-word name: maps, drive, gmail, translate", () => {
  for (const [word, name] of [["maps", "Google Maps"], ["Maps", "Google Maps"], ["drive", "Google Drive"], ["gmail", "Gmail"], ["translate", "Google Translate"]]) {
    const action = siteSearchKey("Tab", {}, bar(word!));
    assert.deepEqual(action?.kind === "enter" && [action.scope.kind, action.scope.name, action.from], ["site", name, word], word);
  }
  assert.equal(bar("map").offered, null);
  assert.equal(bar("maps near me").offered, null);
});

test("Tab accepts the completion when the row offers no site search", () => {
  const state = bar("exampl", "e.org");
  assert.equal(state.offered, null);
  assert.deepEqual(siteSearchKey("Tab", {}, state), { kind: "accept", text: "example.org" });
});

test("Tab with nothing to enter or accept is left to the caller (it moves the selection)", () => {
  assert.equal(siteSearchKey("Tab", {}, bar("hello world")), null);
  assert.equal(siteSearchKey("Tab", {}, bar("")), null);
});

test("Shift+Tab never enters site search", () => {
  assert.equal(siteSearchKey("Tab", { shiftKey: true }, bar("google", ".com")), null);
});

test("Tab inside site search does not enter it again", () => {
  const google = bar("google", ".com").offered!;
  assert.equal(siteSearchKey("Tab", {}, bar("", "", google, "google.com")), null);
});

test("Backspace in an empty site search field leaves it and restores the text that was there", () => {
  const x = bar("x.com").offered!;
  const state = bar("", "", x, "x.com");
  assert.deepEqual(siteSearchKey("Backspace", {}, state), { kind: "leave", text: "x.com" });
});

test("site search entered by typing a space leaves with the space: 'x.com ' then Backspace gives 'x.com '", () => {
  const entry = keywordBySpace("x.com", "x.com ");
  assert.deepEqual(entry, { keyword: "x.com", from: "x.com " });
  const x = bar("x.com").offered!;
  assert.deepEqual(siteSearchKey("Backspace", {}, bar("", "", x, entry!.from)), { kind: "leave", text: "x.com " });
});

test("a space typed after the restored 'x.com ' is a plain space, it doesn't enter site search again", () => {
  assert.equal(keywordBySpace("x.com ", "x.com  "), null);
});

test("only a space typed at the end of the text enters site search by keyword", () => {
  assert.equal(keywordBySpace("x.com", "x.coma"), null);
  assert.equal(keywordBySpace("x.com", " x.com"), null);
  assert.equal(keywordBySpace("", " "), null);
});

test("site search asks for Backspace the whole time it is on, so typing never races the registration", () => {
  const x = bar("x.com").offered!;
  assert.equal(asksForBackspace(x), true);
  assert.equal(asksForBackspace(null), false);
});

test("a forwarded Backspace leaves even while JS still holds text the field already deleted", () => {
  const x = bar("x.com").offered!;
  assert.deepEqual(siteSearchKey("Backspace", {}, bar("a", "", x, "x.com")), { kind: "leave", text: "x.com" });
});

test("Backspace with a modifier never leaves site search: the field deletes as usual", () => {
  const state = bar("", "", bar("x.com").offered!, "x.com");
  for (const mods of [{ altKey: true }, { metaKey: true }, { shiftKey: true }, { ctrlKey: true }]) {
    assert.equal(siteSearchKey("Backspace", mods, state), null);
  }
});

test("Backspace outside site search is a plain delete", () => {
  assert.equal(siteSearchKey("Backspace", {}, bar("x.co")), null);
  assert.equal(siteSearchKey("Backspace", {}, bar("")), null);
});

test("Ctrl+Tab is left to the tab switcher", () => {
  assert.equal(siteSearchKey("Tab", { ctrlKey: true }, bar("google", ".com")), null);
});

test("no site search is offered for text with spaces", () => {
  assert.equal(offeredSiteSearch("google maps", "", sources), null);
  assert.equal(offeredSiteSearch("  ", ".com", sources), null);
});

const withShortcut = {
  engines: allEngines([{ id: "docs", name: "Docs", keyword: "do", url: "https://docs.example.org/search?q=%s" }]),
  hosts: ["dogs.example.com"],
};

function shortcutBar(typed: string, completion = ""): SiteSearchKeyState {
  return { typed, completion, scope: null, offered: offeredSiteSearch(typed, completion, withShortcut), scopeFrom: "" };
}

test("Tab enters a search engine's shortcut even when the completion finishes another site: 'do' + 'gs.example.com'", () => {
  const action = siteSearchKey("Tab", {}, shortcutBar("do", "gs.example.com"));
  assert.deepEqual(action?.kind === "enter" && [action.scope.kind, action.scope.name, action.from], ["engine", "Docs", "do"]);
});

test("a shortcut wins over a completion that has no site search of its own: 'do' + 'nate.example.net'", () => {
  const action = siteSearchKey("Tab", {}, shortcutBar("do", "nate.example.net"));
  assert.deepEqual(action?.kind === "enter" && [action.scope.name, action.from], ["Docs", "do"]);
});

test("a shortcut matches in any case: 'DO' + 'gs.example.com'", () => {
  assert.equal(shortcutBar("DO", "gs.example.com").offered?.name, "Docs");
});

test("Backspace after a shortcut entered over a completion gives back what was typed", () => {
  const entered = siteSearchKey("Tab", {}, shortcutBar("do", "gs.example.com"));
  assert.ok(entered?.kind === "enter");
  const state: SiteSearchKeyState = { typed: "", completion: "", scope: entered.scope, offered: null, scopeFrom: entered.from };
  assert.deepEqual(siteSearchKey("Backspace", {}, state), { kind: "leave", text: "do" });
});

test("text that only starts a shortcut still follows the completion: 'd' + 'ogs.example.com'", () => {
  const offered = shortcutBar("d", "ogs.example.com").offered;
  assert.deepEqual(offered && [offered.kind, offered.host], ["history", "dogs.example.com"]);
});
