import assert from "node:assert/strict";
import { test } from "node:test";
const { changedChoices, choicesFor, conflictBrowsers, loginAge, matchingConflicts, newerCounts, newestVersion, planLogins, resolutionOf, resolvedLogins } = await import("./passwordConflicts.ts");

const login = (browserId, profileId, url, username, password, times = {}) => ({ browserId, profileId, credential: { url, username, password, ...times }, consent: null });
const ORDER = ["chrome", "arc", "firefox"];

test("the same password for the same account from several browsers is saved once, under the first browser", () => {
  const plan = planLogins(
    [
      login("chrome", "p", "https://mail.example/login", "me", "same"),
      login("arc", "p", "https://mail.example/other/page", "me", "same"),
      login("firefox", "p", "mail.example", "me", "same"),
    ],
    ORDER,
  );
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.merged, 2);
  assert.deepEqual(plan.clean, [{ browserId: "chrome", profileId: "p", origin: "https://mail.example", username: "me", password: "same", consent: null }]);
});

test("different passwords for one account make one conflict naming every browser that has it, in run order", () => {
  const plan = planLogins(
    [
      login("arc", "p", "https://bank.example/", "me", "new", { lastUsed: 2_000 }),
      login("chrome", "p", "https://bank.example/", "me", "old", { created: 1_000 }),
      login("firefox", "p", "https://bank.example/", "me", "old", { created: 500 }),
    ],
    ORDER,
  );
  assert.equal(plan.conflicts.length, 1);
  const [c] = plan.conflicts;
  assert.equal(c.site, "bank.example");
  assert.equal(c.username, "me");
  assert.deepEqual(c.versions.map((v) => v.browserId), ["chrome", "arc", "firefox"]);
  assert.equal(newestVersion(c), "arc");
  assert.deepEqual(JSON.stringify(c).includes("new") || JSON.stringify(c).includes("old"), false, "a conflict never carries the password");
  assert.deepEqual(resolvedLogins(plan, {}).map((l) => l.password), ["new"]);
  assert.deepEqual(resolvedLogins(plan, { [c.id]: "chrome" }).map((l) => [l.browserId, l.password]), [["chrome", "old"]]);
});

test("accounts in different destination profiles or with different usernames never conflict", () => {
  const plan = planLogins(
    [
      login("chrome", "personal", "https://a.example/", "me", "1"),
      login("arc", "work", "https://a.example/", "me", "2"),
      login("arc", "personal", "https://a.example/", "you", "3"),
    ],
    ORDER,
  );
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.clean.length, 3);
});

test("logins without a usable origin or password are dropped, as a single import drops them", () => {
  const plan = planLogins([login("chrome", "p", "", "me", "x"), login("chrome", "p", "https://b.example/", "me", ""), login("chrome", "p", "android://x", "me", "y")], ORDER);
  assert.deepEqual(plan.clean.map((l) => l.origin), ["android://x"]);
});

test("a realm that is a web address is the origin, as it is when importing one browser", () => {
  const plan = planLogins([login("chrome", "p", "https://app.example/", "me", "1"), { browserId: "arc", profileId: "p", credential: { url: "https://other.example/", realm: "https://app.example/x", username: "me", password: "2" } }], ORDER);
  assert.equal(plan.conflicts.length, 1);
});

test("within one browser, the newest copy of an account stands for it", () => {
  const plan = planLogins([login("chrome", "p", "https://c.example/", "me", "a", { created: 1 }), login("chrome", "p", "https://c.example/", "me", "b", { lastUsed: 9 }), login("arc", "p", "https://c.example/", "me", "b")], ORDER);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.clean[0].password, "b");
});

test("newest is the later of last used and created, and a tie goes to the earlier browser", () => {
  assert.equal(loginAge({ created: 5, lastUsed: 3 }), 5);
  assert.equal(loginAge({}), 0);
  const plan = planLogins([login("chrome", "p", "https://d.example/", "me", "a", { created: 7 }), login("arc", "p", "https://d.example/", "me", "b", { lastUsed: 7 })], ORDER);
  assert.equal(newestVersion(plan.conflicts[0]), "chrome");
  assert.deepEqual(newerCounts(plan.conflicts), {}, "a tie makes neither browser newer");
});

test("choosing one browser takes its version where it has one and the newest elsewhere", () => {
  const plan = planLogins(
    [
      login("chrome", "p", "https://e.example/", "me", "1", { created: 10 }),
      login("arc", "p", "https://e.example/", "me", "2", { created: 20 }),
      login("chrome", "p", "https://f.example/", "me", "3", { created: 30 }),
      login("firefox", "p", "https://f.example/", "me", "4", { created: 5 }),
    ],
    ORDER,
  );
  const [e, f] = plan.conflicts;
  assert.deepEqual(choicesFor(plan.conflicts, "arc"), { [e.id]: "arc", [f.id]: "chrome" });
  assert.deepEqual(choicesFor(plan.conflicts, "newest"), { [e.id]: "arc", [f.id]: "chrome" });
  assert.deepEqual(conflictBrowsers(plan.conflicts, ORDER), ["chrome", "arc", "firefox"]);
  assert.deepEqual(newerCounts(plan.conflicts), { arc: 1, chrome: 1 });
  assert.equal(changedChoices({ [e.id]: "arc", [f.id]: "chrome" }, { [e.id]: "chrome", [f.id]: "chrome" }), 1);
  assert.deepEqual(matchingConflicts(plan.conflicts, " F.EX ").map((c) => c.id), [f.id]);
  assert.deepEqual(matchingConflicts(plan.conflicts, "").length, 2);
});

test("a resolution reads as newest, one browser, or custom", () => {
  assert.equal(resolutionOf("newest"), "newest");
  assert.equal(resolutionOf("custom"), "custom");
  assert.equal(resolutionOf("arc"), "browser");
});

test("one origin written with a different host case or its default port is the same account", () => {
  const plan = planLogins(
    [login("chrome", "p", "https://accounts.example.test/", "me", "a", { created: 1 }), login("arc", "p", "https://ACCOUNTS.EXAMPLE.TEST:443/sign-in", "me", "b", { created: 2 })],
    ORDER,
  );
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].origin, "https://accounts.example.test");
  assert.equal(plan.clean.length, 0);
  const same = planLogins([login("chrome", "p", "http://Site.example:80/", "me", "x"), login("arc", "p", "http://site.example/a", "me", "x")], ORDER);
  assert.deepEqual([same.clean.length, same.merged], [1, 1]);
  const ports = planLogins([login("chrome", "p", "https://site.example:8443/", "me", "x"), login("arc", "p", "https://site.example/", "me", "y")], ORDER);
  assert.deepEqual([ports.clean.length, ports.conflicts.length], [2, 0], "a different port is a different origin");
});

test("rows that would read the same show their full origin, and the profile shows only when the conflicts span several", async () => {
  const { conflictRows } = await import("./passwordConflicts.ts");
  const plan = planLogins(
    [
      login("chrome", "p", "https://www.site.example/", "me", "1"),
      login("arc", "p", "https://www.site.example/", "me", "2"),
      login("chrome", "p", "http://site.example/", "me", "3"),
      login("arc", "p", "http://site.example/", "me", "4"),
    ],
    ORDER,
  );
  assert.deepEqual(conflictRows(plan.conflicts).map((r) => [r.title, r.showsProfile]), [["https://www.site.example", false], ["http://site.example", false]]);
  const two = planLogins([login("chrome", "a", "https://x.example/", "me", "1"), login("arc", "a", "https://x.example/", "me", "2"), login("chrome", "b", "https://x.example/", "me", "3"), login("arc", "b", "https://x.example/", "me", "4")], ORDER);
  assert.deepEqual(conflictRows(two.conflicts).map((r) => [r.title, r.showsProfile]), [["x.example", true], ["x.example", true]]);
});

test("a zero-padded default port and an expanded IPv6 address are the same origin", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  assert.equal(sameOriginKey("https://Accounts.Example.test:0443"), "https://accounts.example.test");
  assert.equal(sameOriginKey("http://site.example:080"), "http://site.example");
  assert.equal(sameOriginKey("https://site.example:8443"), "https://site.example:8443");
  assert.equal(sameOriginKey("http://[0:0:0:0:0:0:0:1]:8080"), "http://[::1]:8080");
  assert.equal(sameOriginKey("http://[::1]:8080"), "http://[::1]:8080");
  const plan = planLogins([login("chrome", "p", "https://a.example:0443/x", "me", "1"), login("arc", "p", "https://A.EXAMPLE", "me", "2")], ORDER);
  assert.equal(plan.conflicts.length, 1);
});

test("destination profiles that share a name are told apart by their icon, or by their place", async () => {
  const { profileLabels } = await import("./passwordConflicts.ts");
  const profiles = [{ id: "a", name: "Work", icon: null }, { id: "b", name: "work", icon: null }, { id: "c", name: "Home", icon: "🏠" }, { id: "d", name: "Home", icon: "🌴" }, { id: "e", name: "Solo" }];
  assert.deepEqual(profileLabels(["a", "b", "c", "d", "e", "gone"], profiles), { a: "Work (1)", b: "work (2)", c: "🏠 Home", d: "🌴 Home", e: "Solo", gone: "another profile" });
});

test("a trailing dot is its own origin, while case, a padded default port, IPv6 spelling and Unicode or punycode hosts are not", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  assert.notEqual(sameOriginKey("https://example.com"), sameOriginKey("https://example.com."));
  assert.equal(sameOriginKey("https://EXAMPLE.com."), "https://example.com.");
  assert.equal(sameOriginKey("https://bücher.example"), sameOriginKey("https://xn--bcher-kva.example"));
  assert.equal(sameOriginKey("https://BÜCHER.example:0443"), "https://xn--bcher-kva.example");
  assert.equal(sameOriginKey("http://[0:0:0:0:0:0:0:1]"), "http://[::1]");
  assert.equal(sameOriginKey("http://[::FFFF:1]:0080"), "http://[::ffff:1]");
  const plan = planLogins([login("chrome", "p", "https://example.com/", "me", "1"), login("arc", "p", "https://example.com./", "me", "2")], ORDER);
  assert.deepEqual([plan.clean.length, plan.conflicts.length], [2, 0]);
});

test("hosts fold as Chromium reads them: ideographic and fullwidth dots, fullwidth letters and IDN case, with a trailing dot kept", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  const ascii = "https://xn--bcher-kva.example";
  for (const host of ["https://bücher\u3002example", "https://bücher\uff0eexample", "https://bücher\uff61example", "https://BÜCHER.example", "https://ｂüｃｈｅｒ.ｅｘａｍｐｌｅ"]) assert.equal(sameOriginKey(host), ascii, host);
  assert.equal(sameOriginKey("https://ＥＸＡＭＰＬＥ.com"), "https://example.com");
  assert.notEqual(sameOriginKey("https://bücher.example."), ascii);
  assert.equal(sameOriginKey("https://bücher\u3002example\u3002"), `${ascii}.`);
});

test("logins for two Ardia profiles on one password store group together, and the row names both", async () => {
  const { conflictRows } = await import("./passwordConflicts.ts");
  const store = (id) => (id === "work" ? "" : id === "default" ? "" : id);
  const plan = planLogins([login("chrome", "default", "https://a.example/", "me", "1"), login("edge", "work", "https://a.example/", "me", "2"), login("arc", "work", "https://b.example/", "me", "3"), login("edge", "default", "https://b.example/", "me", "3")], ORDER, store);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0].profileIds, ["default", "work"]);
  assert.deepEqual([plan.clean.length, plan.merged], [1, 1]);
  assert.equal(conflictRows(plan.conflicts)[0].showsProfile, true);
});

test("a percent-encoded host is the same origin as its decoded form, and invalid escapes stay as they are", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  const ascii = "https://xn--bcher-kva.example";
  assert.equal(sameOriginKey("https://b%C3%BCcher.example"), ascii);
  assert.equal(sameOriginKey("https://b%c3%bccher.example/sign-in"), ascii);
  assert.equal(sameOriginKey("https://%65xample.com"), "https://example.com");
  assert.equal(sameOriginKey("https://b%C3cher.example"), "https://b%C3cher.example");
  const plan = planLogins([login("chrome", "p", "https://b%C3%BCcher.example/", "me", "1"), login("arc", "p", "https://bücher.example/", "me", "2")], ORDER);
  assert.equal(plan.conflicts.length, 1);
});

test("an escape that decodes to anything but host text keeps the host as written, so it never meets a valid origin", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  assert.equal(sameOriginKey("https://example.com%3A8443"), "https://example.com%3A8443");
  assert.notEqual(sameOriginKey("https://example.com%3A8443"), sameOriginKey("https://example.com:8443"));
  assert.equal(sameOriginKey("https://example.com%2Fpath"), "https://example.com%2Fpath");
  assert.equal(sameOriginKey("https://exa%00mple.com"), "https://exa%00mple.com");
  assert.equal(sameOriginKey("https://example%2Ecom"), "https://example.com");
  assert.equal(sameOriginKey("https://ex%25ample.com"), "https://ex%25ample.com");
  assert.ok(!sameOriginKey("https://exa%00mple.com").includes("\u0000"));
  const plan = planLogins([login("chrome", "p", "https://example.com%3A8443/", "me", "same"), login("arc", "p", "https://example.com:8443/", "me", "same")], ORDER);
  assert.deepEqual(plan.clean.map((l) => l.origin).sort(), ["https://example.com%3A8443", "https://example.com:8443"]);
});

const VECTORS = [
  "https://a.example",
  "https://A.EXAMPLE",
  "https://a%E3%80%82example",
  "https://a\u3002example",
  "https://a_b.example",
  "https://a%5Fb.example",
  "https://A_B.example",
  "https://a1.example.com",
  "https://a%E2%92%88example.com",
  "https://a\u2488example.com",
  "https://example.com",
  "https://EXAMPLE.com:443",
  "https://example.com:0443",
  "https://example%2Ecom",
  "https://\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25.com",
  "https://example\uff0ecom",
  "https://example.com.",
  "https://example.com:8443",
  "https://example.com%3A8443",
  "https://example.com%2Fpath",
  "https://exa%00mple.com",
  "https://ex%25ample.com",
  "https://bücher.example",
  "https://b%C3%BCcher.example",
  "https://BÜCHER.example",
  "https://xn--bcher-kva.example",
  "https://b%C3cher.example",
  "https://ab.example",
  "https://a%C2%ADb.example",
  "https://a\u200bb.example",
  "https://%CE%9F%CE%A3.1example",
  "https://\u039f\u03a3.1example",
  "https://\u03bf\u03c3.1example",
  "https://\u03bf\u03c2.1example",
  "http://[::1]",
  "http://[0:0:0:0:0:0:0:1]",
  "http://[::1]:80",
  "http://[::1]:8080",
];

const nodeOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

test("two origins share a key exactly when a WHATWG URL parser gives them the same origin", async () => {
  const { sameOriginKey } = await import("./passwordConflicts.ts");
  for (const a of VECTORS)
    for (const b of VECTORS) {
      const same = nodeOrigin(a) !== null && nodeOrigin(a) === nodeOrigin(b);
      assert.equal(sameOriginKey(a) === sameOriginKey(b), same || a === b, `${a} vs ${b}`);
    }
});
