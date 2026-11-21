import assert from "node:assert/strict";
import { test } from "node:test";

const { fetchFailedBefore, forgetAsked, markAsked, noteFetchFailed, unmarkAsked } = await import("./askedFavicons.ts");

test("a page is asked once per profile until it is unmarked or forgotten, and forgetting keeps the pages still cached", () => {
  assert.equal(markAsked("p", "https://a.test/"), true);
  assert.equal(markAsked("p", "https://a.test/"), false);
  assert.equal(markAsked("q", "https://a.test/"), true);
  unmarkAsked("p", "https://a.test/");
  assert.equal(markAsked("p", "https://a.test/"), true);
  markAsked("p", "https://b.test/");
  forgetAsked("p", { "https://b.test/": "data:image/png;base64,B" });
  assert.equal(markAsked("p", "https://a.test/"), true);
  assert.equal(markAsked("p", "https://b.test/"), false);
  assert.equal(markAsked("q", "https://a.test/"), false);
  forgetAsked("q");
  assert.equal(markAsked("q", "https://a.test/"), true);
});

test("failed icon fetches keep only the newest ones, so the oldest is fetched again", () => {
  for (let i = 0; i < 5; i++) noteFetchFailed(`p|https://icon${i}.test/i.png`, 3);
  assert.equal(fetchFailedBefore("p|https://icon0.test/i.png"), false);
  assert.equal(fetchFailedBefore("p|https://icon1.test/i.png"), false);
  for (let i = 2; i < 5; i++) assert.equal(fetchFailedBefore(`p|https://icon${i}.test/i.png`), true);
});
