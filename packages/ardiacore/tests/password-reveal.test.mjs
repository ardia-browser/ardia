import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { devtools, freePort, sleep } from "../../../scripts/lib/instance.mjs";

const chrome = process.env.ARDIA_BROWSE_CHROME;
const skip = !(chrome && existsSync(chrome)) && "set ARDIA_BROWSE_CHROME to a Chrome binary to run the page script's password reveal in a real page";
const pageScript = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");
const LOGIN = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<form><input id="user" autocomplete="username"><input id="pw" type="password" autocomplete="current-password" style="width:240px;height:32px"><button>Sign in</button></form>`;
const AUTOFILL_STATE = `{
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (selector) {
    return selector === ":autofill" ? this.dataset.autofilled === "1" : matches.call(this, selector);
  };
}`;

let dir, child, page, url;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "ardia-reveal-"));
  writeFileSync(join(dir, "login.html"), LOGIN);
  url = pathToFileURL(join(dir, "login.html")).href;
  const port = await freePort();
  child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (target) page = await devtools(target, { name: "password reveal" });
    } catch {}
    if (!page) await sleep(100);
  }
  assert.ok(page, "headless Chrome didn't start");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
});

after(async () => {
  page?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(async () => {
  if (skip) return;
  await page.send("Page.navigate", { url });
  for (let i = 0; i < 100 && (await page.eval("document.readyState").catch(() => "")) !== "complete"; i++) await sleep(50);
  await page.eval(`${AUTOFILL_STATE}; (${pageScript})(() => {}); document.getElementById("pw").focus(); "ok"`);
});

const type = (text) => page.send("Input.insertText", { text });
const autofill = (on) => page.eval(`document.getElementById("pw").dataset.autofilled = "${on ? 1 : 0}"`);
const fieldType = () => page.eval(`document.getElementById("pw").type`);
const eyeShown = async () => {
  await sleep(30);
  return page.eval(`document.querySelector("ardia-reveal")?.style.display === "block"`);
};
const clickEye = async () => {
  const { x, y } = await page.eval(`(() => { const s = document.querySelector("ardia-reveal").style; const r = document.querySelector("ardia-reveal").getBoundingClientRect(); return { x: parseFloat(s.left) + r.width / 2, y: parseFloat(s.top) + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await sleep(30);
};

test("a password typed by hand gets the eye, which shows and hides it", { skip }, async () => {
  await type("hunter2");
  assert.equal(await eyeShown(), true);
  await clickEye();
  assert.equal(await fieldType(), "text");
  await clickEye();
  assert.equal(await fieldType(), "password");
});

test("an autofilled password never gets the eye, whether the browser marks it before or after its input event", { skip }, async () => {
  await autofill(true);
  await type("saved-secret");
  assert.equal(await eyeShown(), false);
  await page.eval(`document.getElementById("pw").dataset.autofilled = "0"; document.getElementById("pw").value = ""; document.getElementById("pw").dispatchEvent(new Event("input", { bubbles: true }))`);
  await page.eval(`document.getElementById("pw").addEventListener("input", (e) => { e.target.dataset.autofilled = "1"; }, { once: true }); "ok"`);
  await type("saved-secret");
  assert.equal(await eyeShown(), false);
});

test("editing an autofilled password keeps the eye away until the field is emptied and typed again", { skip }, async () => {
  await autofill(true);
  await type("saved-secret");
  await autofill(false);
  await type("x");
  assert.equal(await eyeShown(), false);
  await page.eval(`document.getElementById("pw").value = ""; document.getElementById("pw").dispatchEvent(new Event("input", { bubbles: true }))`);
  await type("typed-now");
  assert.equal(await eyeShown(), true);
});

test("a password the browser filled without an input event stays without the eye once the field is focused and edited", { skip }, async () => {
  await page.eval(`(() => { const pw = document.getElementById("pw"); pw.blur(); pw.value = "saved-secret"; pw.dataset.autofilled = "1"; pw.focus(); return "ok"; })()`);
  await autofill(false);
  await type("x");
  assert.equal(await eyeShown(), false);
});

test("a shown eye whose field the browser then autofills hides on click instead of revealing", { skip }, async () => {
  await type("hunter2");
  assert.equal(await eyeShown(), true);
  await autofill(true);
  await clickEye();
  assert.equal(await fieldType(), "password");
  assert.equal(await eyeShown(), false);
});

test("a revealed password that the browser then autofills is hidden again on the next click, not toggled", { skip }, async () => {
  await type("hunter2");
  await clickEye();
  assert.equal(await fieldType(), "text");
  await autofill(true);
  await clickEye();
  assert.equal(await fieldType(), "password");
  assert.equal(await eyeShown(), false);
});
