import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHROMIUM_MISSING, launchChromium } from "../../../scripts/lib/test-chromium.mjs";

const pageScript = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");
const nativeRelay = readFileSync(new URL("../ios/ArdiaWebView+LoginList.mm", import.meta.url), "utf8");
const pageMessages = readFileSync(new URL("../ios/ArdiaWebView+PageMessages.mm", import.meta.url), "utf8");

const OTHER_SITE = "https://bank.test";
const FIXTURE = `<!doctype html><body style="margin:0">
<form><input id="u" autocomplete="username" style="position:absolute;left:10px;top:10px;width:300px;height:30px">
<input id="p" type="password" style="position:absolute;left:10px;top:60px;width:300px;height:30px"></form>
<script>
const events = (window.__events = []);
for (const type of ["input", "change"]) document.addEventListener(type, (e) => events.push(type + ":" + e.target.id), true);
</script></body>`;

const CLAIMS = {
  "a window.origin naming another site": () => Object.defineProperty(window, "origin", { value: "https://bank.test", configurable: true }),
  "a history entry naming another site's path": () => history.replaceState(null, "", "/https://bank.test/login"),
  "a field named after another site's origin": () => {
    const u = document.getElementById("u");
    u.name = "https://bank.test";
    u.value = "https://bank.test";
  },
};

async function openFixture(browser) {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await context.addInitScript(`window.__ardiaPosts = []; window.__ardiaReceive = (${pageScript})((kind, json) => window.__ardiaPosts.push([kind, json]));`);
  await context.route("https://page.test/**", (route) => route.fulfill({ contentType: "text/html", body: FIXTURE }));
  const page = await context.newPage();
  await page.goto("https://page.test/login");
  const run = (fn, arg) => page.evaluate(fn, arg);
  await run(() => window.__ardiaReceive("config", JSON.stringify({ loginList: { on: true } })));
  return { page, run };
}

const loginFields = async (run) => (await run(() => window.__ardiaPosts.splice(0))).filter(([kind]) => kind === "loginField").map(([, json]) => JSON.parse(json));
const fillReplies = async (run) => (await run(() => window.__ardiaPosts.splice(0))).filter(([kind]) => kind === "loginFilled").map(([, json]) => JSON.parse(json));

test("B2: a page that claims another site can't make the Login list relay name any origin; native takes the engine's", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run } = await openFixture(browser);
  for (const claim of Object.values(CLAIMS)) await run(claim);
  await run(() => document.getElementById("u").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  assert.deepEqual(await loginFields(run), [], "a made-up press asks for no Login list");
  await page.mouse.click(30, 25);
  const reported = await loginFields(run);
  assert.equal(reported.length, 1, "a real press on the username field asks for the Login list");
  assert.equal(reported[0].field, "username");
  assert.deepEqual(Object.keys(reported[0]).filter((key) => /origin|url|host|site|frame/i.test(key)), [], "the message has no origin, address or frame for native to trust");
  assert.match(pageMessages, /\[kind isEqualToString:@"loginField"\] && dict\) \{\s+\[self loginFieldFromPage:dict frame:frameId main:main origin:VerifiedOrigin\(verifiedOrigin\)\];/, "native passes the engine's verified origin");
  assert.doesNotMatch(nativeRelay, /(Text|Field<NSString>)\(d, @"(origin|url|host)"|(?<![\w.])d\[@"(origin|url|host)"\]/, "native reads no origin from the page's message");
});

test("B2: a fill naming another site's origin or another field fills nothing, and the right one fills", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run } = await openFixture(browser);
  await page.mouse.click(30, 25);
  const [{ token }] = await loginFields(run);
  const fill = (message) => run((m) => window.__ardiaReceive("loginFill", JSON.stringify(m)), message);
  const seen = () => run(() => ({ u: document.getElementById("u").value, p: document.getElementById("p").value, events: window.__events.splice(0) }));
  await fill({ ticket: "1", token, origin: OTHER_SITE, username: "ada@example.test", password: "fixture-pw-ada-1" });
  await fill({ ticket: "2", token: `${Number(token) + 1}`, origin: "https://page.test", username: "ada@example.test", password: "fixture-pw-ada-1" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "1", filled: false }, { ticket: "2", filled: false }]);
  assert.deepEqual(await seen(), { u: "", p: "", events: [] }, "nothing reaches the page");
  await fill({ ticket: "3", token, origin: "https://page.test", username: "ada@example.test", password: "fixture-pw-ada-1" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "3", filled: true }]);
  assert.deepEqual(await seen(), { u: "ada@example.test", p: "fixture-pw-ada-1", events: ["input:u", "change:u", "input:p", "change:p"] }, "the field it was opened for fills");
});

test("Escape reaches native even before the page hears the Login list is open, so a list shown a moment ago still closes", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run } = await openFixture(browser);
  await page.mouse.click(30, 25);
  const [{ token }] = await loginFields(run);
  await page.keyboard.press("Escape");
  assert.deepEqual(await loginFields(run), [{ event: "key", key: "escape", token }]);
});

const CODE_FIXTURE = `<!doctype html><body style="margin:0">
<form><input id="c" autocomplete="one-time-code" inputmode="numeric" style="position:absolute;left:10px;top:10px;width:300px;height:30px"></form>
<script>
const events = (window.__events = []);
for (const type of ["input", "change"]) document.addEventListener(type, (e) => events.push(type + ":" + e.target.id), true);
</script></body>`;

async function openCodeFixture(browser, origin, body = CODE_FIXTURE) {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await context.addInitScript(`window.__ardiaPosts = []; window.__ardiaReceive = (${pageScript})((kind, json) => window.__ardiaPosts.push([kind, json]));`);
  await context.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body }));
  const page = await context.newPage();
  await page.goto(`${origin}/verify`);
  const run = (fn, arg) => page.evaluate(fn, arg);
  await run(() => window.__ardiaReceive("config", JSON.stringify({ loginList: { on: true } })));
  const fill = (message) => run((m) => window.__ardiaReceive("loginFill", JSON.stringify(m)), message);
  const seen = () => run(() => ({ c: document.getElementById("c").value, events: window.__events.splice(0) }));
  return { page, run, fill, seen, origin };
}

test("a code field fills only an empty, visible field on https, and only with a code of 4 to 10 letters and digits", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run, fill, seen, origin } = await openCodeFixture(browser, "https://page.test");
  await page.mouse.click(30, 25);
  const [report] = await loginFields(run);
  assert.equal(report.field, "code");
  const { token } = report;
  for (const [ticket, code] of [["1", "12"], ["2", "12345678901"], ["3", "13 579"], ["4", "<b>1357</b>"]]) await fill({ ticket, token, origin, code });
  assert.deepEqual(await fillReplies(run), ["1", "2", "3", "4"].map((ticket) => ({ ticket, filled: false })), "a value that isn't a code fills nothing");
  await run(() => (document.getElementById("c").value = "34"));
  await fill({ ticket: "5", token, origin, code: "135790" });
  await run(() => (document.getElementById("c").value = ""));
  await run(() => (document.getElementById("c").style.visibility = "hidden"));
  await fill({ ticket: "6", token, origin, code: "135790" });
  await run(() => (document.getElementById("c").style.visibility = ""));
  assert.deepEqual(await fillReplies(run), [{ ticket: "5", filled: false }, { ticket: "6", filled: false }], "a field holding text, or hidden, takes no code");
  assert.deepEqual(await seen(), { c: "", events: [] }, "nothing reaches the page");
  await page.mouse.click(30, 25);
  const [again] = (await loginFields(run)).filter((r) => r.event === "show");
  await fill({ ticket: "7", token: again.token, origin, code: "135790" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "7", filled: true }]);
  assert.deepEqual(await seen(), { c: "135790", events: ["input:c", "change:c"] }, "the empty code field it was opened for fills");
  await page.mouse.click(30, 25);
  assert.deepEqual((await loginFields(run)).filter((r) => r.event !== "hide"), [], "a code field that holds text asks for no code list");
});

test("an http page's code field asks for no code list and takes no code", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run, fill, seen, origin } = await openCodeFixture(browser, "http://page.test");
  await page.mouse.click(30, 25);
  assert.deepEqual((await loginFields(run)).filter((r) => r.event !== "hide"), []);
  await fill({ ticket: "1", token: "1", origin, code: "135790" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "1", filled: false }]);
  assert.deepEqual(await seen(), { c: "", events: [] });
});

test("a field named for a verification code is a code field even without autocomplete, and a zip or search box isn't", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const box = (id, attributes, top) => `<input id="${id}" ${attributes} style="position:absolute;left:10px;top:${top}px;width:300px;height:30px">`;
  const body = `<!doctype html><body style="margin:0"><form>
${box("named", 'name="verification_code" inputmode="numeric"', 10)}
${box("otp", 'name="otp_input"', 60)}
${box("zip", 'name="zip" inputmode="numeric"', 110)}
${box("search", 'type="search" name="q"', 160)}
${box("mail", 'name="otp" autocomplete="email"', 210)}
</form></body>`;
  const { page, run } = await openCodeFixture(browser, "https://page.test", body);
  const kinds = {};
  for (const [id, y] of [["named", 25], ["otp", 75], ["zip", 125], ["search", 175], ["mail", 225]]) {
    await page.mouse.click(30, y);
    kinds[id] = (await loginFields(run)).filter((r) => r.event !== "hide").map((r) => r.field)[0] ?? null;
  }
  assert.deepEqual(kinds, { named: "code", otp: "code", zip: null, search: null, mail: null });
});

const SIGN_UP_FIXTURE = `<!doctype html><body style="margin:0">
<form><input id="u" autocomplete="username" style="position:absolute;left:10px;top:10px;width:300px;height:30px">
<input id="p" type="password" autocomplete="new-password" maxlength="24" minlength="10" pattern="[A-Za-z0-9-]+" style="position:absolute;left:10px;top:60px;width:300px;height:30px">
<input id="c" type="password" autocomplete="new-password" maxlength="20" style="position:absolute;left:10px;top:110px;width:300px;height:30px"></form>
<form><input id="cu" autocomplete="username" style="position:absolute;left:10px;top:200px;width:300px;height:30px">
<input id="old" type="password" autocomplete="current-password" style="position:absolute;left:10px;top:250px;width:300px;height:30px">
<input id="new" type="password" style="position:absolute;left:10px;top:300px;width:300px;height:30px">
<input id="again" type="password" style="position:absolute;left:10px;top:350px;width:300px;height:30px"></form>
<script>
const events = (window.__events = []);
for (const type of ["input", "change"]) document.addEventListener(type, (e) => events.push(type + ":" + e.target.id), true);
</script></body>`;

test("a new-password field reports its form's rules, and a strong password fills every new-password field of that form only", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run, fill } = await openCodeFixture(browser, "https://page.test", SIGN_UP_FIXTURE);
  const values = () => run(() => Object.fromEntries(["u", "p", "c", "old", "new", "again"].map((id) => [id, document.getElementById(id).value])));
  const shown = async (y) => {
    await page.mouse.click(30, y);
    return (await loginFields(run)).filter((r) => r.event !== "hide")[0];
  };
  assert.equal(await shown(25), undefined, "a sign-up form's username field opens no Login list");
  const report = await shown(75);
  assert.deepEqual([report.field, report.typed, report.maxLength, report.minLength, report.pattern], ["newPassword", "", 20, 10, "[A-Za-z0-9-]+"]);
  await fill({ ticket: "2", token: report.token, origin: OTHER_SITE, newPassword: "Abcd-Efgh-2345-Jkmn" });
  await fill({ ticket: "3", token: report.token, origin: "https://page.test", newPassword: "" });
  await fill({ ticket: "4", token: report.token, origin: "https://page.test", newPassword: "Abcd-Efgh-2345-Jkmn" });
  assert.deepEqual(await fillReplies(run), ["2", "3", "4"].map((ticket) => ({ ticket, filled: ticket === "4" })));
  assert.deepEqual(await values(), { u: "", p: "Abcd-Efgh-2345-Jkmn", c: "Abcd-Efgh-2345-Jkmn", old: "", new: "", again: "" });
  const current = await shown(265);
  assert.equal(current.field, "password", "a change-password form's current password is a sign-in field");
  const changed = await shown(315);
  assert.equal(changed.field, "newPassword", "its other two password fields are new ones");
  await fill({ ticket: "5", token: changed.token, origin: "https://page.test", newPassword: "Pqrs-Tuvw-6789-Xyza" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "5", filled: true }]);
  assert.deepEqual(await values(), { u: "", p: "Abcd-Efgh-2345-Jkmn", c: "Abcd-Efgh-2345-Jkmn", old: "", new: "Pqrs-Tuvw-6789-Xyza", again: "Pqrs-Tuvw-6789-Xyza" });
});

const IDENTIFIER_FIXTURE = `<!doctype html><body style="margin:0">
<form id="f"><input id="u" type="email" autocomplete="username" style="position:absolute;left:10px;top:10px;width:300px;height:30px"></form>
<script>
const events = (window.__events = []);
for (const type of ["input", "change"]) document.addEventListener(type, (e) => events.push(type + ":" + e.target.id), true);
window.__grow = () => {
  const p = document.createElement("input");
  p.id = "p";
  p.type = "password";
  p.setAttribute("style", "position:absolute;left:10px;top:60px;width:300px;height:30px");
  document.getElementById("f").append(p);
};
</script></body>`;

test("a username-first step that grows a password field fills both once pressed again, and a fill with nothing to fill reports it", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run, fill } = await openCodeFixture(browser, "https://page.test", IDENTIFIER_FIXTURE);
  const values = () => run(() => ({ u: document.getElementById("u").value, p: document.getElementById("p")?.value ?? null }));
  await page.mouse.click(30, 25);
  const [first] = (await loginFields(run)).filter((r) => r.event !== "hide");
  assert.equal(first.field, "identifier");
  await fill({ ticket: "1", token: first.token, origin: "https://page.test", username: "", password: "" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "1", filled: false }], "nothing to put in the page is no fill");
  await run(() => window.__grow());
  await page.mouse.click(30, 25);
  const [again] = (await loginFields(run)).filter((r) => r.event !== "hide");
  assert.equal(again.field, "username", "the same field is now a sign-in form's username");
  assert.equal(again.token, first.token, "and keeps its token");
  await fill({ ticket: "2", token: again.token, origin: "https://page.test", username: "ada@example.test", password: "fixture-pw-ada-1" });
  assert.deepEqual(await fillReplies(run), [{ ticket: "2", filled: true }]);
  assert.deepEqual(await values(), { u: "ada@example.test", p: "fixture-pw-ada-1" }, "the password field the page grew fills too");
});
