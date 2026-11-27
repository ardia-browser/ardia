import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSwiftTests } from "./swift-testing.mjs";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("a WebKit tab's backdrop shows only while the tab does", (t) => {
  runSwiftTests(t, "page-backdrop-test", ["../ios/WebKitPageBackdrop.swift", "./webkit-page-backdrop.test.swift"]);
});

test("a WebKit tab repaints its backdrop whenever it is shown or hidden, so a hidden one never covers earlier tabs", () => {
  const tab = read("../ios/WebKitTab.swift");
  const errorPage = read("../ios/WebKitTab+ErrorPage.swift");
  const updateHidden = tab.match(/func updateHidden\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(updateHidden, "WebKitTab.updateHidden exists");
  assert.match(updateHidden[1], /^\s*isHidden = !visible$/m);
  assert.match(updateHidden[1], /view\.isHidden = WebKitFullscreenPage\.hidesPage\(view, in: self, visible: visible\)/);
  assert.match(updateHidden[1], /paintBackdrop\(\)/);
  assert.match(tab, /var visible = true \{ didSet \{ updateHidden\(\)/);
  assert.match(errorPage, /layer\?\.backgroundColor = safety\.backdrop\.layerColor\(visible: visible\)/);
  assert.doesNotMatch(errorPage, /layer\?\.backgroundColor = safety\.backdrop(\?)?\.(color\?\.)?cgColor/);
});
