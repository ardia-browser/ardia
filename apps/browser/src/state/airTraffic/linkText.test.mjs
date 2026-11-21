import assert from "node:assert/strict";
import { test } from "node:test";

await import("../../test-native/index.ts");
const { docs: stubDocs, refusedWrites: stubFail } = await import("../../test-native/shell.ts");
const rules = await import("./rules.ts");
const store = await import("./store.ts");

test("contains and exact-address conditions save, load and match literally", () => {
  const contains = { kind: "contains", text: "meet.google.com" };
  const equals = { kind: "equals", text: "example.com/docs" };
  const rule = (id, when) => ({ id, enabled: true, from: null, when, profileId: null, open: "tab" });
  const config = { rules: [rule("a", contains), rule("b", equals)], fallback: null };
  assert.deepEqual(rules.parseAirTraffic(rules.airTrafficJson(config)).rules.map((r) => r.when), [contains, equals]);
  const unsafe = { rules: [rule("c", { kind: "equals", text: "example.com/?q" }), rule("d", { kind: "contains", text: "/" }), rule("e", { kind: "contains", text: "" }), rule("f", { kind: "contains", text: "x".repeat(3000) })], fallback: null };
  assert.deepEqual(rules.parseAirTraffic(rules.airTrafficJson(unsafe)).rules, []);
  assert.ok(rules.linkMatches({ kind: "contains", text: "Upper" }, "https://a.example/upper"));
  assert.ok(rules.linkMatches({ kind: "contains", text: "*" }, "https://a.example/?q=*"));
  assert.ok(!rules.linkMatches({ kind: "contains", text: "*" }, "https://a.example/"));
  assert.ok(rules.linkMatches(equals, "https://www.example.com/docs/?x=1"));
  assert.ok(!rules.linkMatches(equals, "https://example.com/docs/more"));
  assert.ok(rules.linkMatches({ kind: "equals", text: "localhost:3000/app" }, "http://localhost:3000/app"));
});

test("a fallback the person sets, even back to Ardia's usual routing, is remembered as chosen", () => {
  store.resetAirTrafficForTests(rules.NO_AIR_TRAFFIC);
  assert.equal(store.currentAirTraffic().fallbackChosen, undefined);
  store.setAirTrafficFallback(null);
  assert.equal(store.currentAirTraffic().fallbackChosen, true);
  const saved = rules.parseAirTraffic(rules.airTrafficJson(store.currentAirTraffic()));
  assert.deepEqual(saved, { rules: [], fallback: null, fallbackChosen: true });
  assert.equal(rules.fallbackChosen({ rules: [], fallback: { profileId: "p", open: "tab" } }), true, "a fallback set before choices were remembered counts as chosen");
  assert.equal(rules.fallbackChosen(rules.parseAirTraffic(rules.airTrafficJson({ rules: [], fallback: null }))), false);
});

test("a rule added with a given id is added once", () => {
  store.resetAirTrafficForTests(rules.NO_AIR_TRAFFIC);
  const draft = { enabled: true, from: null, when: { kind: "contains", text: "a.example" }, profileId: null, open: "tab" };
  assert.equal(store.addAirTrafficRule(draft, "arc-R-1"), "arc-R-1");
  assert.equal(store.addAirTrafficRule({ ...draft, open: "littleArdia" }, "arc-R-1"), null);
  assert.equal(store.currentAirTraffic().rules.length, 1);
});

test("the entered text is kept as typed and only normalized when matching, so a repeated www. survives a restart and an edit", () => {
  store.resetAirTrafficForTests(rules.NO_AIR_TRAFFIC);
  stubDocs.clear();
  const id = store.addAirTrafficRule({ enabled: true, from: null, when: { kind: "contains", text: "WWW.www.Example.org" }, profileId: null, open: "tab" });
  const reloaded = rules.parseAirTraffic(rules.airTrafficJson(store.currentAirTraffic()));
  assert.deepEqual(reloaded.rules[0].when, { kind: "contains", text: "WWW.www.Example.org" });
  store.resetAirTrafficForTests(reloaded);
  store.updateAirTrafficRule(id, { open: "window" });
  const again = rules.parseAirTraffic(rules.airTrafficJson(store.currentAirTraffic()));
  assert.equal(again.rules.length, 1);
  assert.equal(again.rules[0].when.text, "WWW.www.Example.org");
  assert.ok(rules.linkMatches(again.rules[0].when, "https://www.www.example.org/page"));
  const exact = { kind: "equals", text: "www.www.example.org/a" };
  assert.deepEqual(rules.parseAirTraffic(rules.airTrafficJson({ rules: [{ id: "x", enabled: true, from: null, when: exact, profileId: null, open: "tab" }], fallback: null })).rules[0].when, exact);
  assert.ok(rules.linkMatches(exact, "http://www.www.example.org/a/"));
});

test("an exact address compares host, port and path the same way on both sides, and bad ones are refused", () => {
  const exact = (text) => ({ kind: "equals", text });
  assert.ok(rules.linkMatches(exact("example.com:443/docs"), "https://example.com/docs"));
  assert.ok(rules.linkMatches(exact("https://Example.com:80/Docs/"), "http://example.com/docs?x"));
  assert.ok(rules.linkMatches(exact("localhost:3000/app"), "http://localhost:3000/app/"));
  assert.ok(!rules.linkMatches(exact("localhost:3000/app"), "http://localhost:3001/app"));
  for (const bad of ["example.com/?q=1", "example.com/#top", "exa mple.com", "http://", "a@b.example/x"]) assert.ok(rules.linkTextProblem("equals", bad), bad);
});

test("catch-all text is refused, pointing to Any link", () => {
  for (const text of ["/", "  ", "http://", "www.", "?", "/#/", "https://www./"]) {
    for (const kind of ["contains", "equals"]) assert.match(rules.linkTextProblem(kind, text) ?? "", /Any link/, `${kind} ${JSON.stringify(text)}`);
  }
  assert.equal(rules.linkTextProblem("contains", "*"), null);
});

test("a setting with a synced record counts as chosen", async () => {
  const { settingSyncedIn } = await import("../sync/settingsAdapter.ts");
  assert.equal(settingSyncedIn({}, "cleanUpInactiveTabsAfterMinutes"), false);
  assert.equal(settingSyncedIn({ "set:cleanUpInactiveTabsAfterHours": { v: { v: null } } }, "cleanUpInactiveTabsAfterMinutes"), true);
  assert.equal(settingSyncedIn({ "set:openLinksInLittleArdia": { v: { v: true } } }, "openLinksInLittleArdia"), true);
});

test("adding a rule or setting the fallback reports whether it was saved", () => {
  store.resetAirTrafficForTests(rules.NO_AIR_TRAFFIC);
  const draft = { enabled: true, from: null, when: { kind: "contains", text: "a.example" }, profileId: null, open: "tab" };
  stubFail.on = true;
  try {
    assert.equal(store.addAirTrafficRule(draft, "arc-x"), null);
    assert.equal(store.setAirTrafficFallback({ profileId: null, open: "tab" }), false);
    assert.equal(store.currentAirTraffic().rules.length, 0);
  } finally {
    stubFail.on = false;
  }
  stubFail.returnsFalse = true;
  try {
    assert.deepEqual(store.tryAddAirTrafficRule(draft, "arc-x"), { refused: "unsaved" }, "Windows answers a failed write with false");
  } finally {
    stubFail.returnsFalse = false;
  }
  assert.equal(store.addAirTrafficRule(draft, "arc-x"), "arc-x");
  assert.deepEqual(store.tryAddAirTrafficRule(draft, "arc-x"), { refused: "exists" });
  assert.equal(store.setAirTrafficFallback({ profileId: null, open: "tab" }), true);
  store.resetAirTrafficForTests({ rules: Array.from({ length: rules.MAX_AIR_TRAFFIC_RULES }, (_, i) => ({ ...draft, id: `r${i}` })), fallback: null });
  assert.deepEqual(store.tryAddAirTrafficRule(draft), { refused: "full" });
});

test("exact addresses are compared in their canonical web form, and only http and https count", () => {
  const exact = (text) => ({ kind: "equals", text });
  assert.ok(rules.linkMatches(exact("example.org/café"), "https://example.org/caf%C3%A9"));
  assert.ok(rules.linkMatches(exact("example.org/caf%C3%A9"), "https://example.org/café"));
  assert.ok(rules.linkMatches(exact("example.org/a/../docs"), "https://example.org/docs"));
  assert.ok(rules.linkMatches(exact("example.org/docs"), "https://example.org/a/./../docs/"));
  assert.ok(rules.linkMatches(exact("bücher.example/x"), "https://xn--bcher-kva.example/x"));
  assert.ok(rules.linkTextProblem("equals", "ftp://example.org/x"));
  assert.ok(!rules.linkMatches(exact("example.org/x"), "ftp://example.org/x"));
});
