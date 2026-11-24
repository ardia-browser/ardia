import assert from "node:assert/strict";
import { test } from "node:test";
import { addsRows, answered, askedKey, remoteListFor, remoteSitesFor } from "./lateRemote.ts";

const maps = { url: "https://maps.google.com/", title: "Google Maps" };
const nothing = { text: "", engine: "", list: [], sites: [] };

test("an answer for a longer query keeps the suggestions already drawn and adds the new ones below", () => {
  const drawn = { text: "rea", engine: "google", list: ["react router", "react native", "reading"], sites: [] };
  assert.deepEqual(remoteListFor(drawn, "react", "google"), ["react router", "react native"]);
  const next = answered(drawn, "react", "google", ["react native", "react hooks", "react query"], [maps], "a1");
  assert.deepEqual(next.list, ["react router", "react native", "react hooks", "react query"]);
  assert.deepEqual(next.sites, [], "a new site would land above the drawn suggestions, so it waits");
  assert.ok(addsRows(drawn, next, "react", "google", true));
});

test("an answer with nothing drawn yet is taken as it is", () => {
  const next = answered(nothing, "maps", "google", ["maps directions"], [maps], "a1");
  assert.deepEqual(next, { text: "maps", engine: "google", list: ["maps directions"], sites: [maps] });
  assert.deepEqual(remoteSitesFor(next, "maps.g", "google"), [maps]);
});

test("a carried suggestion hidden as the typed text itself doesn't hold back a site", () => {
  const drawn = { text: "map", engine: "google", list: ["maps"], sites: [] };
  const next = answered(drawn, "maps", "google", ["maps directions"], [maps], "a1");
  assert.deepEqual(next.sites, [maps]);
});

test("an answer that comes after the bar stopped waiting for its query changes nothing", () => {
  const drawn = { text: "rea", engine: "google", list: ["react router"], sites: [], gaveUp: askedKey("google", "react", 3) };
  const next = answered(drawn, "react", "google", ["react hooks"], [maps], askedKey("google", "react", 3));
  assert.equal(next, drawn);
  assert.notEqual(answered(drawn, "react", "google", ["react hooks"], [maps], askedKey("google", "react", 4)), drawn, "a later attempt for the same text gets its own wait");
  assert.equal(addsRows(drawn, next, "react", "google", true), false);
});

test("another engine's answer for the same text is a new answer, not one already in", () => {
  const drawn = { text: "react", engine: "google", list: ["react router"], sites: [] };
  assert.deepEqual(remoteListFor(drawn, "react", "bing"), []);
  assert.deepEqual(answered(drawn, "react", "bing", ["react js"], [], "a1"), { text: "react", engine: "bing", list: ["react js"], sites: [] });
});

test("only rows that will show count as added", () => {
  const drawn = { text: "react", engine: "google", list: ["a1", "a2", "a3", "a4"], sites: [] };
  assert.equal(addsRows(drawn, answered(drawn, "react", "google", ["a5"], [], "a1"), "react", "google", true), false, "past the four shown suggestions");
  assert.equal(addsRows(drawn, answered(drawn, "react", "google", ["a1"], [], "a1"), "react", "google", true), false, "only repeats");
});

test("an explicit search counts its suggestions without the question mark and shows no sites", () => {
  const drawn = { text: "", engine: "", list: [], sites: [] };
  assert.equal(addsRows(drawn, answered(drawn, "? maps", "google", ["maps"], [maps], "a1"), "? maps", "google", true), false);
});

test("a scope shows no engine sites, so a site-only answer adds nothing there", () => {
  const drawn = { text: "", engine: "", list: [], sites: [] };
  assert.equal(addsRows(drawn, answered(drawn, "maps", "google", [], [maps], "a1"), "maps", "google", false), false);
  assert.equal(addsRows(drawn, answered(drawn, "maps", "google", [], [maps], "a1"), "maps", "google", true), true);
});
