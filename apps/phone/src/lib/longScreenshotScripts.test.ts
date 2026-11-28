import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const kotlin = readFileSync(fileURLToPath(new URL("../../../../packages/phone/android/src/main/java/com/ardia/phone/LongScreenshots.kt", import.meta.url)), "utf8");

const shipped = (name: string) => {
  const found = new RegExp(`${name} = """([\\s\\S]*?)"""`).exec(kotlin);
  assert.ok(found, `${name} is in LongScreenshots.kt`);
  return found[1]!;
};

const KEY_A = "ardia-long-shot-6f1c2d3e-0a4b-4c5d-8e9f-a0b1c2d3e4f5";
const KEY_B = "ardia-long-shot-11111111-2222-4333-8444-555555555555";

const hide = (key: string) => shipped("HIDE_FIXED").replaceAll("ARDIA_CAPTURE_KEY", key);
const show = (key: string) => shipped("SHOW_FIXED").replaceAll("ARDIA_CAPTURE_KEY", key);

function page(body: string) {
  const dom = new JSDOM(`<!doctype html><html><head><style>.bar{position:fixed;top:0}.head{position:sticky;top:0}</style></head><body>${body}</body></html>`, { runScripts: "outside-only" });
  const run = (script: string) => dom.window.eval(script);
  const byId = (id: string) => dom.window.document.getElementById(id)!;
  return { dom, run, byId };
}

test("a capture hides fixed elements, unsticks sticky ones, and puts back each element's own style attribute exactly", () => {
  const { run, byId } = page('<div id="bar" class="bar" style="color: red">bar</div><h2 id="head" class="head">head</h2><p id="plain" style="margin: 1px">text</p>');
  assert.equal(run(hide(KEY_A)), 2);
  assert.equal(byId("bar").style.getPropertyValue("opacity"), "0");
  assert.equal(byId("head").style.getPropertyValue("position"), "relative");
  assert.equal(byId("plain").getAttribute("style"), "margin: 1px");
  assert.equal(run(show(KEY_A)), 2);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
  assert.equal(byId("head").hasAttribute("style"), false);
  assert.equal(byId("plain").getAttribute("style"), "margin: 1px");
});

test("cleanup never touches an element the page marked itself with the attribute the old scripts trusted", () => {
  const { run, byId, dom } = page('<div id="bar" class="bar">bar</div><p id="mine" data-ardia-long-shot="sx" style="color: blue">page owned</p>');
  dom.window.document.documentElement.setAttribute("data-ardia-long-shot", "");
  run(hide(KEY_A));
  run(show(KEY_A));
  assert.equal(byId("mine").getAttribute("style"), "color: blue");
  assert.equal(byId("bar").hasAttribute("style"), false);
});

test("an element the page removes during the capture still gets its style back if it returns", () => {
  const { run, byId, dom } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(hide(KEY_A));
  const bar = byId("bar");
  bar.remove();
  run(show(KEY_A));
  dom.window.document.body.append(bar);
  assert.equal(bar.getAttribute("style"), "color: red");
});

test("cleanup with another capture's key, or twice, changes nothing", () => {
  const { run, byId } = page('<div id="bar" class="bar" style="color: red">bar</div>');
  run(hide(KEY_A));
  assert.equal(run(show(KEY_B)), 0);
  assert.equal(byId("bar").style.getPropertyValue("opacity"), "0");
  run(show(KEY_A));
  assert.equal(run(show(KEY_A)), 0);
  assert.equal(byId("bar").getAttribute("style"), "color: red");
});

test("the page sees no marker attribute while it is captured", () => {
  const { run, dom } = page('<div id="bar" class="bar">bar</div>');
  run(hide(KEY_A));
  assert.equal(dom.window.document.querySelectorAll("[data-ardia-long-shot]").length, 0);
  assert.equal(dom.window.document.documentElement.hasAttribute("data-ardia-long-shot"), false);
});
