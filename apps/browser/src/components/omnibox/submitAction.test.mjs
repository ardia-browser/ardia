import assert from "node:assert/strict";
import { test } from "node:test";
const { returnAction, submitAction } = await import("./submitAction.ts");

const SEARCH = "https://www.google.com/search?q=%s";
const resolve = (over) => returnAction({ hasRow: false, text: "", typed: "", scope: null, providerSettled: false, searchUrl: SEARCH, ...over });
const bar = (action, rowShown = action.kind === "row") => submitAction({ hero: false, action, rowShown });
const newTabBar = (action, rowShown = action.kind === "row") => submitAction({ hero: true, action, rowShown });

test("Return resolves to the highlighted row first, even inside a provider scope", () => {
  assert.deepEqual(resolve({ hasRow: true }), { kind: "row" });
  assert.deepEqual(resolve({ hasRow: true, text: "kit", typed: "kit", scope: "provider" }), { kind: "row" });
});

test("with no row, Return opens the URL the text resolves to, the same way the keyboard does", () => {
  assert.deepEqual(resolve({ text: "example.com" }), { kind: "url", url: "https://example.com" });
  assert.equal(resolve({ text: "summer rec" }).kind, "url");
  assert.deepEqual(resolve({ text: "?kit" }), { kind: "url", url: "https://www.google.com/search?q=kit" });
});

test("a bare ? or blank text resolves to nothing, so no frame offers Go", () => {
  for (const text of ["?", " ? ", "", "   "]) {
    const action = resolve({ text });
    assert.deepEqual(action, { kind: "none" }, JSON.stringify(text));
    assert.equal(bar(action).shown, false);
    assert.deepEqual(newTabBar(action), { shown: true, enabled: false, returnCue: false });
  }
});

test("a provider query still in flight is pending: Go behaves as Return, which queues its first result", () => {
  const pending = resolve({ typed: "abc", text: "abc", scope: "provider" });
  assert.deepEqual(pending, { kind: "pending" });
  assert.deepEqual(bar(pending), { shown: true, enabled: true, returnCue: true });
  assert.deepEqual(newTabBar(pending), { shown: true, enabled: true, returnCue: true });
});

test("a provider that answered with nothing, a provider scope with no text and any other scope with no rows have no action", () => {
  assert.deepEqual(resolve({ typed: "zzz", text: "zzz", scope: "provider", providerSettled: true }), { kind: "none" });
  assert.deepEqual(resolve({ typed: "", text: "", scope: "provider" }), { kind: "none" });
  assert.deepEqual(resolve({ typed: "x", text: "x", scope: "other" }), { kind: "none" });
});

test("the command bar and the sidebar dropdown offer Go ↩ when Return opens the text's URL", () => {
  assert.deepEqual(bar(resolve({ text: "example.com" })), { shown: true, enabled: true, returnCue: true });
});

test("a highlighted row owns Return, so the command bar hides Go", () => {
  assert.deepEqual(bar({ kind: "row" }), { shown: false, enabled: false, returnCue: false });
});

test("the New Tab bar's Go is live whenever Return would act, and quiet while a visible row carries ↩", () => {
  assert.deepEqual(newTabBar(resolve({ hasRow: true, text: "kit", typed: "kit", scope: "provider" })), { shown: true, enabled: true, returnCue: false });
  assert.deepEqual(newTabBar(resolve({ text: "example.com" })), { shown: true, enabled: true, returnCue: true });
});

test("when the New Tab bar's list is hidden, its Go carries ↩ for the row Return would open", () => {
  assert.deepEqual(newTabBar({ kind: "row" }, false), { shown: true, enabled: true, returnCue: true });
});
