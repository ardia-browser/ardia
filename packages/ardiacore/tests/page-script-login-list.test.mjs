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
