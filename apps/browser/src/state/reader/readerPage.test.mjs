import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
const { READABILITY, READERABLE, READABILITY_VERSION } = await import("./readabilitySource.ts");
const { readerCall, readerCheckCall, readerOpenCall, readerToggleCall } = await import("./readerPage.ts");
const { READER_SIZES, READER_SIZE_NAMES } = await import("./tokens.ts");
const { SETTING_SPECS } = await import("../settings/settings.ts");

test("the vendored extractor evaluates to Readability and isProbablyReaderable without leaving a global behind", () => {
  const context = vm.createContext({});
  const readability = vm.runInContext(READABILITY, context);
  const readerable = vm.runInContext(READERABLE, context);
  assert.equal(typeof readability, "function");
  assert.equal(typeof readability.prototype.parse, "function");
  assert.equal(typeof readerable, "function");
  assert.deepEqual(Object.keys(context), []);
  assert.match(READABILITY_VERSION, /^\d+\.\d+\.\d+$/);
});

test("every page call is one script body that posts its result", () => {
  const look = { dark: true, size: 2, font: "sans" };
  for (const code of [readerCheckCall(), readerToggleCall(look), readerOpenCall(look), readerCall("state"), readerCall("hide"), readerCall("setLook", look)]) {
    assert.doesNotThrow(() => new Function("post", code));
    assert.match(code, /post\("result", JSON\.stringify\(/);
  }
});

test("the page call installs the reader once and leaves the page alone until asked", () => {
  const posted = [];
  const window = {};
  const context = vm.createContext({ window, post: (kind, json) => posted.push([kind, JSON.parse(json)]), document: { body: null }, location: { href: "https://a.example/" } });
  vm.runInContext(`(function(post){${readerCall("state")}})(post)`, context);
  const installed = window[Symbol.for("ardia.reader")];
  assert.ok(installed);
  vm.runInContext(`(function(post){${readerCall("state")}})(post)`, context);
  assert.equal(window[Symbol.for("ardia.reader")], installed);
  assert.deepEqual(posted.map(([kind, report]) => [kind, report.active]), [["result", false], ["result", false]]);
});

test("a page with no body offers no reader", () => {
  const posted = [];
  const window = {};
  const context = vm.createContext({ window, post: (kind, json) => posted.push(JSON.parse(json)), document: { body: null } });
  vm.runInContext(`(function(post){${readerCheckCall()}})(post)`, context);
  assert.equal(posted[0].readerable, false);
});

test("the text size setting names one size per step the reader offers", () => {
  assert.equal(READER_SIZE_NAMES.length, READER_SIZES.length);
  assert.deepEqual([...SETTING_SPECS.readerTextSize.values], [...READER_SIZE_NAMES]);
  assert.ok(READER_SIZE_NAMES.includes(SETTING_SPECS.readerTextSize.default));
});
