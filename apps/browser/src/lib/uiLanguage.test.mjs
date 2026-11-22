import assert from "node:assert/strict";
import { test } from "node:test";
const { translate, uiLanguageFromTag } = await import("./uiLanguage.ts");

test("simplified Chinese tags select zh-Hans", () => {
  assert.equal(uiLanguageFromTag("zh"), "zh-Hans");
  assert.equal(uiLanguageFromTag("zh-CN"), "zh-Hans");
  assert.equal(uiLanguageFromTag("zh-SG"), "zh-Hans");
  assert.equal(uiLanguageFromTag("zh-Hans"), "zh-Hans");
  assert.equal(uiLanguageFromTag("zh-Hans-CN"), "zh-Hans");
  assert.equal(uiLanguageFromTag("zh_CN"), "zh-Hans");
});

test("traditional Chinese tags stay English", () => {
  assert.equal(uiLanguageFromTag("zh-TW"), "en");
  assert.equal(uiLanguageFromTag("zh-HK"), "en");
  assert.equal(uiLanguageFromTag("zh-MO"), "en");
  assert.equal(uiLanguageFromTag("zh-Hant"), "en");
  assert.equal(uiLanguageFromTag("zh-Hant-TW"), "en");
});

test("other languages stay English", () => {
  assert.equal(uiLanguageFromTag("en-US"), "en");
  assert.equal(uiLanguageFromTag("en-CN"), "en");
  assert.equal(uiLanguageFromTag("ja-JP"), "en");
  assert.equal(uiLanguageFromTag("zh-MY"), "en");
});

test("known copy translates and unknown copy stays", () => {
  assert.equal(translate("Settings", "zh-Hans"), "设置");
  assert.equal(translate("  Settings\n", "zh-Hans"), "  设置\n");
  assert.equal(translate("Not a catalog key", "zh-Hans"), "Not a catalog key");
  assert.equal(translate("Settings", "en"), "Settings");
});
