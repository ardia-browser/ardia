import assert from "node:assert/strict";
import { test } from "node:test";
import { CHROMIUM_MISSING, launchChromium } from "../../../../../scripts/lib/test-chromium.mjs";
const { pickerCall, trustedPickerCall, REFUSED_PICKER } = await import("./elementPicker.ts");
const { acceptedPick, hidingFilter, savablePickedSelector } = await import("./hiddenElements.ts");

const FIXTURE = `<!doctype html><body>
<main>
  <section data-testid="promo">plain</section>
  <section data-testid="promo/*card">comment opener</section>
  <section data-testid="promo\tcard">tab</section>
  <section data-testid="promo\u2028card">line separator</section>
  <section data-testid="promo\u0085card">next line</section>
  <x-ad\u0085box>tag with a next line</x-ad\u0085box>
</main>
</body>`;

const run = (page, code) =>
  page.evaluate((code) => new Promise((resolve) => new Function("post", code)((_, json) => resolve(JSON.parse(json)))), code);

async function pick(page, target) {
  const point = await page.evaluate((target) => {
    const el = [...document.querySelectorAll("main > *")].find((node) => node.textContent === target);
    el.setAttribute("data-fixture-target", "");
    const box = el.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2];
  }, target);
  const result = run(page, pickerCall("start", point));
  await page.waitForFunction(() => !!window[Symbol.for("ardia.elementPicker")]?.session);
  await page.keyboard.press("Enter");
  return (await result).selector;
}

const state = (page, selector) =>
  page.evaluate((selector) => {
    const el = document.querySelector("[data-fixture-target]");
    const found = [...document.querySelectorAll(selector)];
    return { unique: found.length === 1 && found[0] === el, hidden: getComputedStyle(el).display === "none" };
  }, selector);

test("a picked element saves as a rule that finds only it, and the page keeps the saved form live", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  for (const target of ["plain", "comment opener", "tab", "line separator", "next line"]) {
    await page.setContent(FIXTURE);
    const picked = await pick(page, target);
    const filter = hidingFilter("example.com", savablePickedSelector(picked) ?? "");
    assert.ok(filter, `${target}: ${JSON.stringify(picked)} saves`);
    const saved = filter.slice(filter.indexOf("##") + 2);
    t.diagnostic(`${target}: ${saved}`);
    if (target === "plain") assert.equal(saved, picked);
    else assert.notEqual(saved, picked);
    if (saved !== picked) {
      await run(page, pickerCall("apply", [saved]));
      await run(page, pickerCall("unhide", [picked]));
    }
    assert.deepEqual(await state(page, saved), { unique: true, hidden: true }, `${target}: the saved form hides it alone`);
    await run(page, pickerCall("unhide", [saved]));
    assert.deepEqual(await state(page, saved), { unique: true, hidden: false }, `${target}: Show brings it back`);
  }
  await page.setContent(FIXTURE);
  const oddTag = await pick(page, "tag with a next line");
  assert.equal(hidingFilter("example.com", savablePickedSelector(oddTag) ?? ""), null, "a tag name the rule can't hold isn't saved");
});

const TRUST_FIXTURE = `<!doctype html><body style="margin:0">
<div id="fixture-banner" style="position:absolute;left:0;top:0;width:400px;height:100px">banner</div>
<div id="fixture-other" style="position:absolute;left:0;top:200px;width:400px;height:100px">other</div>
</body>`;

const freshPage = (page) => page.goto("data:text/html," + encodeURIComponent(TRUST_FIXTURE));

const pending = (promise, ms = 400) => Promise.race([promise.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), ms))]);

test("a page's own picker object is refused, whether it was set plainly or locked in place", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const plant of [
    () => (window[Symbol.for("ardia.elementPicker")] = { start: () => ({ selector: "#fixture-banner" }), ensure() {}, prove: () => 1 }),
    () => Object.defineProperty(window, Symbol.for("ardia.elementPicker"), { value: { start: () => ({ selector: "#fixture-banner" }), ensure() {} }, configurable: false }),
    () => Object.defineProperty(window, Symbol.for("ardia.elementPicker"), { get: () => undefined, configurable: false }),
  ]) {
    await freshPage(page);
    await page.evaluate(plant);
    assert.deepEqual(await run(page, trustedPickerCall("start", [10, 10])), REFUSED_PICKER);
  }
  await freshPage(page);
  assert.deepEqual(await run(page, trustedPickerCall("apply", [])), true, "the real picker installs on a clean page");
  const replaced = await page.evaluate(() => {
    try {
      Object.defineProperty(window, Symbol.for("ardia.elementPicker"), { value: {} });
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(replaced, false, "an installed picker can't be swapped out");
});

test("an armed picker ignores synthetic clicks, keys and moves, and takes a real click", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(TRUST_FIXTURE);
  const result = run(page, trustedPickerCall("start", [50, 50]));
  await page.waitForFunction(() => !!window[Symbol.for("ardia.elementPicker")]?.session);
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 250, bubbles: true }));
    window.dispatchEvent(new MouseEvent("click", { clientX: 50, clientY: 250, button: 0, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.getElementById("fixture-other").click();
  });
  assert.equal(await pending(result), "pending", "no synthetic event finishes the pick");
  await page.keyboard.press("Enter");
  assert.deepEqual(await result, { selector: "#fixture-banner" }, "a real Enter picks the element the real pointer chose, not the one the page aimed at");
  const second = run(page, trustedPickerCall("start", null));
  await page.waitForFunction(() => !!window[Symbol.for("ardia.elementPicker")]?.session);
  await page.mouse.click(50, 250);
  assert.deepEqual(await second, { selector: "#fixture-other" }, "a real click picks");
});

test("a pick is saved only when the browser saw the confirming input on the same page", () => {
  const offered = { selector: "#fixture-banner" };
  assert.equal(acceptedPick(offered, true, true), "#fixture-banner");
  assert.equal(acceptedPick(offered, false, true), null, "no real click or Return reached the tab");
  assert.equal(acceptedPick(offered, true, false), null, "the tab moved to another page or profile");
  assert.equal(acceptedPick(REFUSED_PICKER, true, true), null, "the page had its own picker");
  assert.equal(acceptedPick({ cancelled: true }, true, true), null);
  assert.equal(acceptedPick(null, true, true), null);
});

test("the hardened picker is a separate script; the shared one stays the text the Linux host pins", () => {
  assert.notEqual(trustedPickerCall("start", null), pickerCall("start", null));
  assert.doesNotMatch(pickerCall("start", null), /isTrusted|prove|defineProperty/);
});

const [FILTER_SYNTAX_OPEN, FILTER_SYNTAX_CLOSE] = ["/" + "*", "*" + "/"];

const HOSTILE_PAGE = `<!doctype html><body style="margin:0">
<div data-testid="promo" style="position:absolute;left:0;top:0;width:400px;height:100px">banner</div>
</body>`;

test("a page that rewrites the helpers the picker calls still can't get a line break or uBlock syntax into a saved rule", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const returns = (target, value) => `${target} = () => ${JSON.stringify(value)}`;
  const tricks = [
    ...["\f", "\v", "\u2028", "\u2029", "\u0085", "\u0000", "\t"].flatMap((br) => [
      returns("Element.prototype.getAttribute", `promo${br}*##+js(set-constant, ardiaFixtureMarker, 1)`),
      returns("Element.prototype.getAttribute", `promo${FILTER_SYNTAX_OPEN}${br}${FILTER_SYNTAX_CLOSE}:style(display:none)`),
    ]),
    returns("Element.prototype.getAttribute", "promo:remove()"),
    returns("Element.prototype.getAttribute", "promo#@#.ad"),
    returns("CSS.escape", "x\r*##+js(set-constant, ardiaFixtureMarker, 1)"),
  ];
  let picks = 0;
  for (const trick of tricks) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(HOSTILE_PAGE);
    await page.evaluate((code) => new Function(code)(), trick);
    const result = run(page, trustedPickerCall("start", [50, 50])).catch(() => null);
    const armed = await page.waitForFunction(() => !!window[Symbol.for("ardia.elementPicker")]?.session, null, { timeout: 300 }).then(() => true, () => false);
    if (armed) await page.keyboard.press("Enter");
    const answer = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 300))]);
    await page.close();
    if (answer?.selector !== undefined) picks++;
    const picked = acceptedPick(answer, true, true);
    if (picked === null) continue;
    const savable = savablePickedSelector(picked);
    const filter = savable === null ? null : hidingFilter("example.com", savable);
    t.diagnostic(`${trick} -> ${JSON.stringify(filter)}`);
    if (filter === null) continue;
    assert.doesNotMatch(filter, /[\n\r\f\v\u0085\u2028\u2029]/, trick);
    const outsideQuotes = filter.slice("example.com##".length).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.doesNotMatch(outsideQuotes, /##|#@#|:style\(|:remove\(|\+js\(/, trick);
  }
  t.diagnostic(`${picks} of ${tricks.length} rewritten pages still finished a pick`);
  assert.ok(picks >= tricks.length - 1, "the rewritten pages still pick, so their selectors reach the checks above");
});

const ch = (code) => String.fromCharCode(code);
const nested = (depth, inner) => "<div>".repeat(depth) + inner + "</div>".repeat(depth);
const VARIED = `<!doctype html><body style="margin:0"><main>
<div id="1st-place">digit id</div>
<div id="a:b.c">punctuated id</div>
<div id="café">accented id</div>
<div id="hero-banner">plain id</div>
<section data-testid="promo 'x' (y)">quoted test id</section>
<section data-qa="a/b#c">qa attribute</section>
<ul><li>one</li><li>two</li><li>third item</li></ul>
<p class="sc:x a-b">escaped class</p>
<p class="中文">cjk class</p>
<x-fancy-card>custom element</x-fancy-card>
<x-ad${ch(0x81)}box>c1 control tag</x-ad${ch(0x81)}box>
<x-ad${ch(0x9f)}box>last c1 tag</x-ad${ch(0x9f)}box>
<x-ad${ch(0xa0)}box>no-break space tag</x-ad${ch(0xa0)}box>
<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>table cell</td></tr></table>
${nested(14, '<span class="leaf-x">deep leaf</span>')}
${nested(14, "<span>deep anonymous</span>")}
</main></body>`;

test("every element the real picker can pick on a varied page saves, and the saved rule finds only it", { skip: CHROMIUM_MISSING, timeout: 60_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 1600 } });
  const targets = ["digit id", "punctuated id", "accented id", "plain id", "quoted test id", "qa attribute", "third item", "escaped class", "cjk class", "custom element", "c1 control tag", "last c1 tag", "no-break space tag", "table cell", "deep leaf", "deep anonymous"];
  for (const target of targets) {
    await page.setContent(VARIED);
    const point = await page.evaluate((target) => {
      const el = [...document.querySelectorAll("main *")].find((node) => node.childElementCount === 0 && node.textContent === target);
      el.setAttribute("data-fixture-target", "");
      const box = el.getBoundingClientRect();
      return [box.left + 4, box.top + box.height / 2];
    }, target);
    const result = run(page, trustedPickerCall("start", null));
    await page.waitForFunction(() => !!window[Symbol.for("ardia.elementPicker")]?.session);
    await page.mouse.click(point[0], point[1]);
    const { selector } = await result;
    const filter = hidingFilter("example.com", savablePickedSelector(selector) ?? "");
    assert.ok(filter, `${target}: ${JSON.stringify(selector)} saves`);
    await run(page, trustedPickerCall("unhide", [selector]));
    const saved = filter.slice("example.com##".length);
    const found = await page.evaluate((saved) => [...document.querySelectorAll(saved)].map((el) => el.hasAttribute("data-fixture-target")), saved);
    assert.ok(found.includes(true), `${target}: ${JSON.stringify(saved)} finds the picked element`);
    if (target !== "deep anonymous") assert.equal(found.length, 1, `${target}: ${JSON.stringify(saved)} finds only the picked element`);
  }
});
