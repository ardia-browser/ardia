import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chromiumCookie,
  cookieFingerprint,
  cookieKey,
  cookieMap,
  forgetRegistrableDomains,
  mergeInto,
  registrableDomain,
  rememberRegistrableDomain,
  scopedBase,
  settledBase,
  storageFingerprint,
  storageMap,
} from "./siteDataMerge.ts";
import { addHop, capBases, forgetSessionCookies, needsCarry, readLedger, siteEntry, sourceIsNewer, touch } from "./siteDataLedger.ts";

const NOW = 1_900_000_000;
const cookie = (patch = {}) => ({ name: "sid", value: "a", domain: ".app.test", path: "/", expires: NOW + 3600, session: false, httpOnly: true, secure: true, ...patch });
const jar = (...cookies) => cookieMap(cookies, NOW);
const baseOf = (...cookies) => Object.fromEntries(cookies.map((c) => [cookieKey(c), cookieFingerprint(c)]));
const keys = (pairs) => pairs.map(([key]) => key);

test("a cookie only the source has is copied, and one the source dropped since the last sync is dropped from the destination", () => {
  const signedIn = cookie();
  const copied = mergeInto(jar(signedIn), jar(), {}, cookieFingerprint, false);
  assert.deepEqual(keys(copied.put), [cookieKey(signedIn)]);
  assert.equal(copied.base[cookieKey(signedIn)], cookieFingerprint(signedIn));

  const cleared = mergeInto(jar(), jar(signedIn), baseOf(signedIn), cookieFingerprint, false);
  assert.deepEqual(keys(cleared.drop), [cookieKey(signedIn)]);
  assert.equal(cleared.base[cookieKey(signedIn)], undefined);
});

test("data cleared on one side never comes back from the other", () => {
  const signedIn = cookie();
  const back = mergeInto(jar(signedIn), jar(), baseOf(signedIn), cookieFingerprint, true);
  assert.deepEqual(back.put, []);
  assert.deepEqual(back.drop, []);
});

test("a change made only on the destination side is left alone, whichever side is newer", () => {
  const old = cookie({ value: "old" });
  const changed = cookie({ value: "new" });
  for (const wins of [true, false]) {
    const merged = mergeInto(jar(old), jar(changed), baseOf(old), cookieFingerprint, wins);
    assert.deepEqual([merged.put, merged.drop, merged.conflicts], [[], [], 0]);
  }
});

test("when both sides changed, the newer side's value wins and the other is kept", () => {
  const was = cookie({ value: "was" });
  const here = cookie({ value: "source" });
  const there = cookie({ value: "dest" });
  const newer = mergeInto(jar(here), jar(there), baseOf(was), cookieFingerprint, true);
  assert.deepEqual(newer.put.map(([, c]) => c.value), ["source"]);
  assert.equal(newer.conflicts, 1);
  const older = mergeInto(jar(here), jar(there), baseOf(was), cookieFingerprint, false);
  assert.deepEqual([older.put, older.conflicts, older.base[cookieKey(was)]], [[], 1, cookieFingerprint(was)]);
});

test("a first sync with no history copies only what one side lacks and settles values both already share", () => {
  const shared = cookie({ name: "shared" });
  const onlyDest = cookie({ name: "theirs" });
  const merged = mergeInto(jar(shared), jar(shared, onlyDest), {}, cookieFingerprint, true);
  assert.deepEqual([merged.put, merged.drop], [[], []]);
  assert.deepEqual(Object.keys(merged.base), [cookieKey(shared)]);
});

test("expiry noise under a minute and expired or partitioned cookies don't count as changes", () => {
  const a = cookie({ expires: NOW + 3600 });
  const b = cookie({ expires: NOW + 3600.4 });
  assert.equal(cookieFingerprint(a), cookieFingerprint(b));
  const hidden = [cookie({ name: "gone", expires: NOW - 1 }), cookie({ name: "p", partitionKey: { topLevelSite: "https://x.test" } }), cookie({ name: "" })];
  assert.equal(jar(...hidden).size, 0);
});

test("history for domains outside the carried set is never read as a deletion", () => {
  const other = cookie({ domain: ".bank.test" });
  const mine = cookie();
  const base = baseOf(other, mine);
  assert.deepEqual(Object.keys(scopedBase(base, ["app.test"])), [cookieKey(mine)]);
});

test("writes that didn't land keep the old history, so the next carry tries again instead of treating the gap as a deletion", () => {
  const before = { k: "1" };
  const merged = mergeInto(storageMap([["k", "2"]]), storageMap([["k", "1"]]), before, storageFingerprint, true);
  assert.deepEqual(merged.put, [["k", "2"]]);
  assert.deepEqual(settledBase(before, merged.base, merged.put, false), before);
  assert.deepEqual(settledBase(before, merged.base, merged.put, true), { k: storageFingerprint("2") });
});

test("a host is its own site until the public suffix list names its registrable domain, which never reaches past the host", () => {
  forgetRegistrableDomains();
  assert.equal(registrableDomain("alice.github.io"), "alice.github.io");
  assert.equal(registrableDomain("WWW.App.Test."), "www.app.test");
  rememberRegistrableDomain("www.app.test", "app.test");
  rememberRegistrableDomain("alice.github.io", "github.io");
  rememberRegistrableDomain("evil.test", "app.test");
  assert.equal(registrableDomain("www.app.test"), "app.test");
  assert.equal(registrableDomain("alice.github.io"), "github.io");
  assert.equal(registrableDomain("evil.test"), "evil.test");
  forgetRegistrableDomains();
});

test("after a relaunch, a session cookie WebKit lost is copied back instead of deleted from Chromium", () => {
  const session = cookie({ session: true, expires: -1 });
  const persistent = cookie({ name: "pref" });
  const ledger = { "": { sites: {}, cookies: baseOf(session, persistent), storage: {} } };
  forgetSessionCookies(ledger);
  const base = ledger[""].cookies;
  assert.deepEqual(Object.keys(base), [cookieKey(persistent)]);
  const toChromium = mergeInto(jar(persistent), jar(session, persistent), base, cookieFingerprint, true);
  assert.deepEqual(toChromium.drop, []);
  const toWebKit = mergeInto(jar(session, persistent), jar(persistent), base, cookieFingerprint, true);
  assert.deepEqual(keys(toWebKit.put), [cookieKey(session)]);
});

test("a source whose drops can't be trusted copies new values but never deletes", () => {
  const kept = cookie({ name: "kept" });
  const fresh = cookie({ name: "fresh" });
  const merged = mergeInto(jar(fresh), jar(kept), baseOf(kept), cookieFingerprint, true, false);
  assert.deepEqual(keys(merged.put), [cookieKey(fresh)]);
  assert.deepEqual(merged.drop, []);
  assert.equal(merged.held, 1);
  assert.equal(merged.base[cookieKey(kept)], cookieFingerprint(kept));
});

test("bases over the cap shed sites nobody uses before the sites in use", () => {
  const p = { sites: {}, cookies: {}, storage: {} };
  const ledger = { "": p };
  touch(ledger, "", "old.test", "webkit", 1_000);
  touch(ledger, "", "new.test", "webkit", 9_000_000);
  for (let i = 0; i < 12_000; i++) {
    p.cookies[`o${i}\u0001.old.test\u0001/`] = "f";
    p.cookies[`n${i}\u0001.new.test\u0001/`] = "f";
  }
  p.cookies["x\u0001.gone.test\u0001/"] = "f";
  capBases(p);
  assert.equal(p.sites["old.test"], undefined);
  assert.ok(p.sites["new.test"]);
  assert.equal(Object.keys(p.cookies).length, 12_000);
  assert.ok(Object.keys(p.cookies).every((k) => k.includes(".new.test")));
});

test("Chromium gets host-only cookies by address and domain cookies by domain, and never SameSite=None without Secure", () => {
  assert.deepEqual(chromiumCookie(cookie({ domain: "app.test", path: "/x", secure: false, sameSite: "None", session: true, expires: -1 })), {
    name: "sid", value: "a", path: "/x", secure: false, httpOnly: true, url: "http://app.test/x",
  });
  assert.equal(chromiumCookie(cookie({ domain: "::1", secure: false })).url, "http://[::1]/");
  assert.equal(chromiumCookie(cookie({ sameSite: undefined })).sameSite, undefined);
  assert.equal(chromiumCookie(cookie({ sameSite: "Lax" })).domain, ".app.test");
  assert.equal(chromiumCookie(cookie()).expires, NOW + 3600);
});

test("a site needs carrying until it has been carried, and again once the other engine used it after that", () => {
  const ledger = {};
  assert.equal(needsCarry(undefined, "webkit", false), true);
  const entry = siteEntry(ledger, "", "app.test");
  touch(ledger, "", "app.test", "chromium", 1_000_000, "https://app.test");
  entry.carried.webkit = 2_000_000;
  assert.equal(needsCarry(entry, "webkit", false), false);
  assert.equal(needsCarry(entry, "webkit", true), true);
  touch(ledger, "", "app.test", "chromium", 3_000_000);
  assert.equal(needsCarry(entry, "webkit", false), true);
  assert.equal(sourceIsNewer(entry, "webkit", false, false), true);
  touch(ledger, "", "app.test", "webkit", 4_000_000);
  assert.equal(sourceIsNewer(entry, "webkit", false, false), false);
  assert.equal(sourceIsNewer(entry, "webkit", true, false), true);
  assert.deepEqual(entry.origins, ["https://app.test"]);
  touch(ledger, "", "app.test", "webkit", 10);
  assert.equal(entry.at.webkit, 10);
});

test("the saved ledger drops anything malformed and keeps learned sign-in hops", () => {
  const ledger = {};
  addHop(ledger, "work", "app.test", "sso.test");
  assert.equal(addHop(ledger, "work", "app.test", "app.test"), false);
  const restored = readLedger(JSON.parse(JSON.stringify({ ...ledger, bad: 4, other: { sites: { x: 1, y: { at: { webkit: "no" }, hops: [1, "h"] } }, cookies: { k: 3, j: "f" } } })));
  assert.deepEqual(restored.work.sites["app.test"].hops, ["sso.test"]);
  assert.equal(restored.bad, undefined);
  assert.deepEqual(restored.other.sites.y, { at: {}, carried: {}, origins: [], hops: ["h"] });
  assert.deepEqual(restored.other.cookies, { j: "f" });
  assert.equal(restored.other.sites.x, undefined);
});

test("capping a heavy ledger of 400 sites with 60 cookies each stays fast", () => {
  const ledger = {};
  const p = (ledger[""] = { sites: {}, cookies: {}, storage: {} });
  for (let s = 0; s < 400; s++) {
    const site = `site${s}.example.test`;
    touch(ledger, "", site, "webkit", 1_000_000 + s * 10_000, `https://www.${site}`);
    addHop(ledger, "", site, `sso${s}.test`);
    for (let c = 0; c < 60; c++) p.cookies[`c${c}\u0001.sub${c % 3}.${site}\u0001/`] = "f";
  }
  const began = performance.now();
  capBases(p);
  const took = performance.now() - began;
  assert.ok(Object.keys(p.cookies).length <= 20_000);
  assert.ok(p.sites["site399.example.test"], "the most recent site stays");
  assert.equal(p.sites["site0.example.test"], undefined, "the oldest goes first");
  assert.ok(took < 1000, `took ${took.toFixed(1)} ms`);
});
