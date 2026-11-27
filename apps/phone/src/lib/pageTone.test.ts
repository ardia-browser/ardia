import assert from "node:assert/strict";
import test from "node:test";
import { barIsDark, pageBarDark, shownTone } from "./pageTone.ts";

test("a page's colours come from the page while it reports them, else from the tab's stored theme colour, as Compose's PageTone.resolve does", () => {
  assert.deepEqual(shownTone({ top: "#111111", bottom: "#222222" }, "#ABCDEF"), { top: "#111111", bottom: "#222222" });
  assert.deepEqual(shownTone(null, "#ABCDEF"), { top: "#ABCDEF", bottom: "#ABCDEF" });
  assert.deepEqual(shownTone({ top: "#111111", bottom: null }, "#ABCDEF"), { top: "#111111", bottom: "#ABCDEF" });
  assert.deepEqual(shownTone(null, null), { top: null, bottom: null });
});

test("the glass's own tone sets the bar's ink only in the glass design; Classic follows the colour under its opaque bar", () => {
  const under = { toneBottom: "#FFFFFF", themeDark: false, bottomDark: false };
  assert.equal(barIsDark({ design: "redesigned", glassTone: true, ...under }), true, "the lens saw a dark image under the bar");
  assert.equal(barIsDark({ design: "original", glassTone: true, ...under }), false, "Classic ignores a glass tone left by any other glass");
  assert.equal(barIsDark({ design: "material", glassTone: true, ...under }), false);
  assert.equal(barIsDark({ design: "redesigned", glassTone: undefined, ...under }), false, "without a glass tone the page colour decides");
  assert.equal(barIsDark({ design: "redesigned", glassTone: undefined, toneBottom: null, themeDark: true, bottomDark: false }), true, "and with no page colour, the theme");
  assert.equal(barIsDark({ design: "original", glassTone: undefined, toneBottom: null, themeDark: true, bottomDark: false }), false);
});

test("an Incognito tab's glass or classic bar on Android is drawn dark natively, so its ink is light whatever the page; iPhone and other designs follow the page", () => {
  const light = { design: "redesigned", glassTone: false, toneBottom: "#FFFFFF", themeDark: false, bottomDark: false, nativeGlass: true };
  assert.equal(pageBarDark({ ...light, incognitoLook: true, os: "android" }), true);
  assert.equal(pageBarDark({ ...light, incognitoLook: true, os: "ios" }), false);
  assert.equal(pageBarDark({ ...light, incognitoLook: false, os: "android" }), false);
  assert.equal(pageBarDark({ ...light, design: "material", incognitoLook: true, os: "android" }), false);
  assert.equal(pageBarDark({ ...light, nativeGlass: false, incognitoLook: true, os: "android" }), false, "the JS-drawn bar has no native rule to agree with");
});
