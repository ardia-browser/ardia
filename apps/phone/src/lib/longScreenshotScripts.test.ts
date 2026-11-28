import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const kotlin = readFileSync(fileURLToPath(new URL("../../../../packages/phone/android/src/main/java/com/ardia/phone/LongScreenshots.kt", import.meta.url)), "utf8");

const shipped = (name: string) => {
  const found = new RegExp(`const val ${name} = """([\\s\\S]*?)"""`).exec(kotlin);
  assert.ok(found, `${name} is in LongScreenshots.kt`);
  return found[1]!;
};

const KEY_A = "ardia-long-shot-6f1c2d3e-0a4b-4c5d-8e9f-a0b1c2d3e4f5";
const KEY_B = "ardia-long-shot-11111111-2222-4333-8444-555555555555";

const scriptFor = (name: string) => (key: string, y: number | null = null) => shipped(name).replaceAll("ARDIA_CAPTURE_KEY", key).replaceAll("ARDIA_SCROLL_Y", y === null ? "null" : String(y));
const mark = scriptFor("MARK");
const scroll = scriptFor("SCROLL");
const owns = (key: string) => `(${scroll(key, 0)}) >= 0 ? 1 : 0`;
const hide = scriptFor("HIDE_FIXED");
const show = scriptFor("SHOW_FIXED");
const drop = scriptFor("DROP");

function page(body: string) {
  const dom = new JSDOM(`<!doctype html><html><head><style>.bar{position:fixed;top:0}.head{position:sticky;top:0}</style></head><body>${body}</body></html>`, { runScripts: "outside-only", url: "https://example.com/a" });
  const run = (script: string) => dom.window.eval(script) as number;
  const byId = (id: string) => dom.window.document.getElementById(id)!;
  return { dom, run, byId };
}

test("a capture marks the document, hides fixed elements, unsticks sticky ones, and puts back each element's own style attribute exactly", () => {
  const { run, byId } = page('<div id="bar" class="bar" style="color: red">bar</div><h2 id="head" class="head">head</h2><p id="plain" style="margin: 1px">text</p>');
  assert.equal(run(owns(KEY_A)), 0);
  assert.equal(run(mark(KEY_A)), 1);
  assert.equal(run(owns(KEY_A)), 1);
  assert.equal(run(hide(KEY_A)), 2);
  assert.equal(byId("bar").style.getPropertyValue("opacity"), "0");
  assert.equal(byId("head").style.getPropertyValue("position"), "relative");
  assert.equal(byId("plain").getAttribute("style"), "margin: 1px");
  assert.equal(run(show(KEY_A)), 2);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
  assert.equal(byId("head").hasAttribute("style"), false);
  assert.equal(run(owns(KEY_A)), 1, "the token outlives the style restore, so publishing can still check the document");
  assert.equal(run(drop(KEY_A)), 1);
  assert.equal(run(owns(KEY_A)), 0);
});

test("without the capture's token nothing is hidden, restored or scrolled for: that is a different document", () => {
  const { run, byId } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  assert.equal(run(hide(KEY_A)), -1);
  assert.equal(run(show(KEY_A)), -1);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
  const fresh = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(mark(KEY_A));
  run(hide(KEY_A));
  assert.equal(fresh.run(owns(KEY_A)), 0, "a reload or redirect starts a window without the token");
  assert.equal(fresh.run(show(KEY_A)), -1, "so cleanup is a no-op there");
});

test("an in-page address change keeps the document, so the capture goes on and cleanup still restores", () => {
  const { run, byId, dom } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(mark(KEY_A));
  run(hide(KEY_A));
  dom.window.history.pushState({}, "", "/b");
  dom.window.location.hash = "#section";
  assert.equal(run(owns(KEY_A)), 1);
  assert.equal(run(show(KEY_A)), 1);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
});

test("cleanup never touches an element the page marked itself with the attribute the old scripts trusted", () => {
  const { run, byId, dom } = page('<div id="bar" class="bar">bar</div><p id="mine" data-ardia-long-shot="sx" style="color: blue">page owned</p>');
  dom.window.document.documentElement.setAttribute("data-ardia-long-shot", "");
  run(mark(KEY_A));
  run(hide(KEY_A));
  run(show(KEY_A));
  assert.equal(byId("mine").getAttribute("style"), "color: blue");
  assert.equal(byId("bar").hasAttribute("style"), false);
});

test("an element the page removes during the capture still gets its style back if it returns", () => {
  const { run, byId, dom } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(mark(KEY_A));
  run(hide(KEY_A));
  const bar = byId("bar");
  bar.remove();
  run(show(KEY_A));
  dom.window.document.body.append(bar);
  assert.equal(bar.getAttribute("style"), "color: red");
});

test("another capture's key changes nothing, a second mark is refused, and a second cleanup is a no-op", () => {
  const { run, byId } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(mark(KEY_A));
  assert.equal(run(mark(KEY_A)), 0);
  run(hide(KEY_A));
  assert.equal(run(show(KEY_B)), -1);
  assert.equal(byId("bar").style.getPropertyValue("opacity"), "0");
  assert.equal(run(show(KEY_A)), 1);
  assert.equal(run(show(KEY_A)), 0);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
});

test("the page sees no marker attribute and no enumerable property while it is captured", () => {
  const { run, dom } = page('<div id="bar" class="bar">bar</div>');
  run(mark(KEY_A));
  run(hide(KEY_A));
  assert.equal(dom.window.document.querySelectorAll("[data-ardia-long-shot]").length, 0);
  assert.equal(Object.keys(dom.window).some((key) => key.includes("ardia")), false);
});

test("a scroll runs only in the capture's own document, in the same script as the check, and leaves the page's own style attribute as it was", () => {
  const { run, dom } = page('<div style="height: 5000px">tall</div>');
  const root = dom.window.document.documentElement;
  root.setAttribute("style", "scroll-behavior: smooth; color: red");
  assert.equal(run(scroll(KEY_A, 300)), -1, "no token, no scroll");
  run(mark(KEY_A));
  assert.ok(run(scroll(KEY_A, 300)) >= 0);
  assert.equal(root.getAttribute("style"), "scroll-behavior: smooth; color: red");
  root.removeAttribute("style");
  run(scroll(KEY_A, 0));
  assert.equal(root.hasAttribute("style"), false, "a page without a style attribute keeps none");
  assert.equal(run(show(KEY_A, 0)), 0, "restoring with a scroll still answers for the token");
  assert.equal(run(drop(KEY_A)), 1, "drop says the token was there");
  assert.equal(run(drop(KEY_A)), 0, "and only once");
  assert.equal(run(scroll(KEY_A, 300)), -1);
});
