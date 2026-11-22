import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
const { pickerCall, trustedPickerCall, REFUSED_PICKER } = await import("./elementPicker.ts");
const { acceptedPick, hidingFilter, savablePickedSelector } = await import("./hiddenElements.ts");

function headlessShell() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const path = join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (existsSync(path)) return path;
  }
  return null;
}

const executablePath = existsSync(chromium.executablePath()) ? undefined : headlessShell();
const BROWSER_MISSING = executablePath === null && "Playwright's Chromium isn't installed";
const launch = () => chromium.launch(executablePath ? { executablePath } : {});

const FIXTURE = `<!doctype html><body>
<main>
  <section data-testid="promo">plain</section>
  <section data-testid="promo/*card">comment opener</section>
  <section data-testid="promo\tcard">tab</section>
  <section data-testid="promo card">line separator</section>
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

test("a picked element saves as a rule that finds only it, and the page keeps the saved form live", { skip: BROWSER_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launch();
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

test("a page's own picker object is refused, whether it was set plainly or locked in place", { skip: BROWSER_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launch();
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

test("an armed picker ignores synthetic clicks, keys and moves, and takes a real click", { skip: BROWSER_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launch();
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
