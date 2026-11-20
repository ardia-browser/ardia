import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bestItem, fillsWithoutChoice, itemTier, isSecureOrigin, loginSavedIn, matchTier, parseSite, publicSuffixOf, rankItems, registrableDomain, sameSite, searchItems, siteKey, TIER } from "./originMatch.ts";

const SHARED_TIERS = JSON.parse(readFileSync(new URL("../../../../../packages/ardiacore/tests/fixtures/vault-origin-tiers.json", import.meta.url), "utf8"));

const item = (id, urls, extra = {}) => ({ provider: "bitwarden", id, title: id, username: `${id}@example.com`, urls, hasTotp: false, ...extra });

test("an insecure page never ranks a login, while plain http on localhost counts as secure", () => {
  assert.equal(isSecureOrigin("http://example.com"), false);
  assert.deepEqual(rankItems([item("a", ["example.com"])], "http://example.com"), []);
  assert.equal(isSecureOrigin("http://localhost:3000"), true);
});

test("a page origin without an http or https scheme is never secure, and a saved address with an impossible port matches nothing", () => {
  for (const origin of ["null", "about:blank", "blob:https://example.com/1", "example.com", "data:text/html,x", ""]) assert.equal(isSecureOrigin(origin), false, origin);
  assert.deepEqual(rankItems([item("a", ["example.com"])], "example.com"), []);
  assert.equal(matchTier("https://bank.com", "https://bank.com:99999999999999999999"), TIER.none);
  assert.equal(matchTier("https://bank.com", "https://bank.com:65536"), TIER.none);
  assert.equal(matchTier("https://bank.com:8443", "https://bank.com:8443"), TIER.exact);
});

test("exact host beats subdomain beats a sibling on the same site", () => {
  const ranked = rankItems([item("sibling", ["https://login.example.com"]), item("parent", ["example.com"]), item("exact", ["https://app.example.com"])], "https://app.example.com");
  assert.deepEqual(ranked.map((r) => r.item.id), ["exact", "parent", "sibling"]);
});

test("www is the bare domain, one step below the exact host", () => {
  const ranked = rankItems([item("bare", ["example.com"]), item("www", ["www.example.com"])], "https://www.example.com");
  assert.deepEqual(ranked.map((r) => r.item.id), ["www", "bare"]);
});

test("ties go to the login used last on the site, then the username", () => {
  const ranked = rankItems(
    [item("b", ["example.com"], { username: "zed" }), item("a", ["example.com"], { username: "amy" }), item("used", ["example.com"], { username: "max" }), item("fav", ["example.com"], { username: "pat", favorite: true })],
    "https://example.com",
    "bitwarden/used",
  );
  assert.deepEqual(ranked.map((r) => r.item.id), ["used", "a", "fav", "b"]);
});

test("the same login from two managers, or saved for http and https, shows once", () => {
  const ranked = rankItems(
    [
      item("bw", ["https://example.com"], { username: "me@example.com" }),
      { ...item("op", ["https://example.com/login"], { username: "Me@Example.com" }), provider: "1password" },
      item("plain", ["http://example.com"], { username: "me@example.com" }),
      item("other", ["https://example.com"], { username: "you@example.com" }),
      item("sub", ["https://login.example.com"], { username: "me@example.com" }),
    ],
    "https://example.com",
  );
  assert.equal(ranked.filter((r) => r.item.username.toLowerCase() === "me@example.com" && r.tier === TIER.exact).length, 1);
  assert.equal(ranked.some((r) => r.item.id === "plain"), false, "the http copy folds into the https login");
  assert.ok(ranked.some((r) => r.item.id === "sub"), "a subdomain login with the same username stays, it's another host");
  assert.ok(ranked.some((r) => r.item.id === "other"));
});

test("a login used last on a site stays even when another manager has the same one", () => {
  const ranked = rankItems([item("bw", ["example.com"], { username: "me" }), { ...item("op", ["example.com"], { username: "me" }), provider: "1password" }], "https://example.com", "1password/op");
  assert.deepEqual(ranked.map((r) => `${r.item.provider}/${r.item.id}`), ["1password/op"]);
});

test("many logins across one site's subdomains rank by tier, siblings last", () => {
  const items = [
    item("mail", ["https://mail.example.com"], { username: "a" }),
    item("root", ["https://example.com"], { username: "b" }),
    item("deep", ["https://x.app.example.com"], { username: "c" }),
    item("here", ["https://app.example.com"], { username: "d" }),
    item("www", ["https://www.app.example.com"], { username: "e" }),
    item("away", ["https://example.org"], { username: "f" }),
  ];
  const ranked = rankItems(items, "https://app.example.com");
  assert.deepEqual(ranked.map((r) => [r.item.id, r.tier]), [["here", TIER.exact], ["www", TIER.www], ["root", TIER.subdomain], ["deep", TIER.subdomain], ["mail", TIER.sibling]]);
  assert.deepEqual(ranked.filter((r) => fillsWithoutChoice(r.item, "https://app.example.com")).map((r) => r.item.id), ["here", "www", "root", "deep"]);
});

test("the best match for copying never falls back to a sibling", () => {
  assert.equal(bestItem([item("sibling", ["https://login.example.com"])], "https://app.example.com"), null);
  assert.equal(bestItem([item("sibling", ["https://login.example.com"]), item("own", ["example.com"])], "https://app.example.com")?.id, "own");
});

test("a login counts as saved only for the same site and the same username, ignoring case", () => {
  const items = [item("x", ["https://example.com"], { username: "Me@Example.com" })];
  assert.equal(loginSavedIn(items, "https://example.com", "me@example.com"), true);
  assert.equal(loginSavedIn(items, "https://login.example.com", " ME@EXAMPLE.COM "), true);
  assert.equal(loginSavedIn(items, "https://example.com", "other@example.com"), false);
  assert.equal(loginSavedIn(items, "https://example.org", "me@example.com"), false);
  assert.equal(loginSavedIn(items, "https://app.example.com", "me@example.com"), true);
  assert.equal(loginSavedIn([item("y", ["https://login.example.com"], { username: "me" })], "https://app.example.com", "me"), true, "a sibling counts, so a save never duplicates it");
  assert.equal(loginSavedIn([item("z", ["https://example.org"], { username: "me" })], "https://app.example.com", "me"), false);
  assert.equal(loginSavedIn([], "https://example.com", ""), false);
});

test("search finds items by title, username or host, every word required", () => {
  const items = [item("GitHub", ["https://github.com"], { username: "octo" }), item("Work Mail", ["https://mail.corp.example"], { username: "me" }), item("Bank", ["bank.example"])];
  assert.deepEqual(searchItems(items, "git").map((i) => i.title), ["GitHub"]);
  assert.deepEqual(searchItems(items, "octo").map((i) => i.title), ["GitHub"]);
  assert.deepEqual(searchItems(items, "corp").map((i) => i.title), ["Work Mail"]);
  assert.deepEqual(searchItems(items, "work me").map((i) => i.title), ["Work Mail"]);
  assert.deepEqual(searchItems(items, "work octo"), []);
  assert.equal(searchItems(items, "").length, 3);
  const many = Array.from({ length: 500 }, (_, i) => item(`Site ${i}`, [`site${i}.example`]));
  assert.equal(searchItems(many, "site", 100).length, 100);
});

test("search ignores accents and how the text was composed", () => {
  const items = [item("Caf\u00e9 Club", ["https://cafe.example"], { username: "Zo\u0065\u0308" }), item("Other", ["https://other.example"])];
  assert.deepEqual(searchItems(items, "cafe").map((i) => i.title), ["Caf\u00e9 Club"]);
  assert.deepEqual(searchItems(items, "Cafe\u0301").map((i) => i.title), ["Caf\u00e9 Club"]);
  assert.deepEqual(searchItems(items, "zo\u00eb").map((i) => i.title), ["Caf\u00e9 Club"]);
  assert.deepEqual(searchItems(items, "CAF\u00c9").map((i) => i.title), ["Caf\u00e9 Club"]);
});

test("same site means the same registrable domain", () => {
  assert.equal(sameSite("https://login.example.com", "https://example.com"), true);
  assert.equal(sameSite("https://a.github.io", "https://b.github.io"), false);
  assert.equal(sameSite("https://example.com", "https://example.org"), false);
});

test("the full public suffix list decides what is a site, with wildcards and exceptions", () => {
  for (const suffix of ["co.uk", "nom.fr", "github.io", "pvt.k12.ma.us"]) assert.equal(registrableDomain(`x.${suffix}`), `x.${suffix}`, suffix);
  assert.equal(registrableDomain("x.com.com"), "com.com");
  assert.equal(publicSuffixOf("anything.foo.ck"), "foo.ck", "a wildcard rule");
  assert.equal(publicSuffixOf("www.ck"), "ck", "an exception ends the wildcard");
  assert.equal(registrableDomain("x.city.kawasaki.jp"), "city.kawasaki.jp");
  assert.equal(registrableDomain("co.uk"), "");
  assert.equal(registrableDomain("x.a.github.io"), "a.github.io");
  assert.equal(registrableDomain("shop.bücher.de"), "xn--bcher-kva.de");
  assert.equal(parseSite("https://*.example.com"), null);
  assert.equal(parseSite("https://exa mple.com"), null);
});

test("the tier table shared with the native check", () => {
  for (const [page, saved, tier, mode] of SHARED_TIERS) {
    const saving = mode ? { urls: [saved], urlMatch: [mode] } : { urls: [saved] };
    if (!mode) assert.equal(matchTier(page, saved), TIER[tier], `${saved} on ${page}`);
    assert.equal(itemTier(saving, page), TIER[tier], `${saved} (${mode ?? "domain"}) on ${page}`);
    assert.equal(fillsWithoutChoice(saving, page), TIER[tier] >= TIER.subdomain, `${saved} on ${page} fills on its own`);
  }
});

test("the remembered login leads its own tier but never jumps a better match", () => {
  const items = [item("fav", ["example.com"], { favorite: true }), item("mine", ["example.com"]), item("sib", ["login.example.com"])];
  assert.deepEqual(rankItems(items, "https://example.com", "bitwarden/mine").map((r) => r.item.id), ["mine", "fav", "sib"]);
  assert.deepEqual(rankItems(items, "https://example.com", "bitwarden/sib").map((r) => r.item.id), ["fav", "mine", "sib"]);
  assert.deepEqual(rankItems(items, "https://example.com", "bitwarden/gone").map((r) => r.item.id), ["fav", "mine", "sib"]);
});

test("a site key is the registrable domain, or the host where there isn't one", () => {
  assert.equal(siteKey("https://accounts.google.com"), "google.com");
  assert.equal(siteKey("https://www.example.co.uk"), "example.co.uk");
  assert.equal(siteKey("https://alice.github.io"), "alice.github.io");
  assert.equal(siteKey("http://localhost:3000"), "localhost");
  assert.equal(siteKey("https://192.168.1.10"), "192.168.1.10");
  assert.equal(siteKey("not a url"), "");
});

test("ten thousand logins across three thousand sites rank in a few milliseconds of CPU per page", () => {
  const many = [];
  for (let site = 0; site < 3000; site++) {
    const base = `site${site}${site % 7 === 0 ? ".co.uk" : ".com"}`;
    many.push(item(`s${site}`, [`https://${base}/login`], { username: `user${site}` }));
    const subs = site % 5 === 0 ? 12 : 1;
    for (let sub = 0; sub < subs; sub++) many.push(item(`s${site}-${sub}`, [`https://a${sub}.${base}`], { username: `user${site}-${sub}` }));
  }
  while (many.length < 10_000) many.push(item(`x${many.length}`, [`https://other${many.length}.example.org`]));
  const heapBefore = process.memoryUsage().heapUsed;
  rankItems(many, "https://a1.site5.com");
  const heapAfter = process.memoryUsage().heapUsed;
  const pages = Array.from({ length: 50 }, (_, i) => `https://a1.site${i * 5}.com`);
  let found = 0;
  let perPage = Infinity;
  for (let run = 0; run < 3; run++) {
    const cpu = process.cpuUsage();
    found = 0;
    for (const page of pages) found += rankItems(many, page).length;
    const used = process.cpuUsage(cpu);
    perPage = Math.min(perPage, (used.user + used.system) / 1000 / pages.length);
  }
  console.log(`rankItems over ${many.length} logins: ${perPage.toFixed(3)} ms per page, caches ${((heapAfter - heapBefore) / 1048576).toFixed(1)} MB`);
  assert.ok(found >= pages.length * 2, "every page finds its own logins");
  assert.ok(perPage < 5, `ranking took ${perPage.toFixed(3)} ms per page`);
  const ranked = rankItems(many, "https://a1.site10.com");
  assert.deepEqual(ranked.map((r) => r.tier), [...ranked.map((r) => r.tier)].sort((a, b) => b - a));
  assert.equal(ranked[0].item.id, "s10-1");
});

test("search over ten thousand logins stays under 5 ms of CPU a keystroke", () => {
  const many = Array.from({ length: 10_000 }, (_, i) => item(`Site ${i}`, [`https://a${i % 50}.site${i}.com`], { username: `user${i}@mail.example` }));
  searchItems(many, "s");
  let worst = 0;
  for (const query of ["s", "si", "sit", "site", "site 1", "site 12", "user", "a3", "mail", "zzz"]) {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const cpu = process.cpuUsage();
      searchItems(many, query);
      const used = process.cpuUsage(cpu);
      best = Math.min(best, (used.user + used.system) / 1000);
    }
    worst = Math.max(worst, best);
  }
  console.log(`search over 10000 logins: worst ${worst.toFixed(2)} ms a keystroke`);
  assert.ok(worst < 5, `a keystroke took ${worst.toFixed(2)} ms`);
  assert.deepEqual(searchItems(many, "site 9999").map((i) => i.title), ["Site 9999"]);
  assert.deepEqual(searchItems(many, "site 101", 3).map((i) => i.title), ["Site 101", "Site 1010", "Site 1011"]);
});
