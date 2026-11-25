import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { getAppLocale, getUiLocale, resolveAppLocale, setAppLocaleOverride, t, tp } from "./index";

describe("i18n locale detection and translation", () => {
  afterEach(() => {
    setAppLocaleOverride(null);
  });

  it("maps Simplified Chinese tags to zh-Hans and others to en", () => {
    assert.equal(resolveAppLocale("zh-Hans"), "zh-Hans");
    assert.equal(resolveAppLocale("zh-Hans-CN"), "zh-Hans");
    assert.equal(resolveAppLocale("zh_CN"), "zh-Hans");
    assert.equal(resolveAppLocale("zh-SG"), "zh-Hans");
    assert.equal(resolveAppLocale("zh"), "zh-Hans");
    assert.equal(resolveAppLocale("zh-Hant-TW"), "en");
    assert.equal(resolveAppLocale("zh-TW"), "en");
    assert.equal(resolveAppLocale("zh-HK"), "en");
    assert.equal(resolveAppLocale("en-US"), "en");
    assert.equal(resolveAppLocale("ja-JP"), "en");
  });

  it("falls back to English text when locale is en or key is missing", () => {
    setAppLocaleOverride("en");
    assert.equal(getAppLocale(), "en");
    assert.equal(t("Missing key {n}", { n: 3 }), "Missing key 3");
    assert.equal(tp("{count} tab", "{count} tabs", 1), "1 tab");
    assert.equal(tp("{count} tab", "{count} tabs", 4), "4 tabs");
  });

  it("switches UI locale formatting and translations to zh-Hans when overridden", () => {
    setAppLocaleOverride("zh-Hans");
    assert.ok(getUiLocale().startsWith("zh-Hans"));
    assert.equal(t("New Tab"), "新建标签页");
    assert.equal(t("Zoom: {percent}%", { percent: 125 }), "缩放：125%");
    assert.equal(tp("Cleared {count} cookie and site data", "Cleared {count} cookies and site data", 3), "已清除 3 条 Cookie 和网站数据");
  });
});
