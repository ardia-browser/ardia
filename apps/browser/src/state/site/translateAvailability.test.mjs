import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.acTestNativeModules = {
  ArdiaTranslate: { available: true, userLanguages: () => ["en-US", "ko"], languageName: (id) => ({ en: "English", ko: "Korean" })[id] ?? id },
};
const { translationMenuTitle } = await import("./translate.ts");

test("manual page translation is offered before language detection and for preferred-language pages", () => {
  assert.equal(translationMenuTitle("https://velog.io/@example", false), "Translate to English");
  assert.equal(translationMenuTitle("http://localhost:8080/", false), "Translate to English");
});

test("the page menu restores the original when translation is active", () => {
  assert.equal(translationMenuTitle("https://velog.io/@example", true), "Show Original");
});

test("browser and non-web pages have no page translation action", () => {
  for (const url of ["ardia://settings", "chrome://settings", "about:blank", "file:///tmp/example.html", ""]) assert.equal(translationMenuTitle(url, false), "");
});
