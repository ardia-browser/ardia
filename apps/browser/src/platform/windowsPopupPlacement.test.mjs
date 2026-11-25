import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POPUP_CHROME_HEIGHT,
  popupFeatures,
  popupFrame,
  popupOriginText,
  popupSecurity,
  popupSize,
  popupTitle,
} from "../../../../packages/expo-windows/src/engine/popupPlacement.ts";

const OPENER = [100, 50, 1200, 800];

test("the engine's popup field keeps only the finite numbers the page gave", () => {
  assert.deepEqual(popupFeatures({ width: 400, height: 300 }), { width: 400, height: 300 });
  assert.deepEqual(popupFeatures({ x: 10, y: "20", width: Number.NaN, height: null }), { x: 10 });
  assert.deepEqual(popupFeatures({}), {});
  assert.equal(popupFeatures(undefined), null);
  assert.equal(popupFeatures(true), null);
  assert.equal(popupFeatures([1, 2]), null);
});

test("a pop-up is the size the page asked for plus the app's caption and origin strip", () => {
  assert.equal(POPUP_CHROME_HEIGHT, 60);
  assert.deepEqual(popupSize({ width: 400, height: 300 }), [400, 360]);
  assert.deepEqual(popupSize({}), [500, 660]);
  assert.deepEqual(popupSize({ width: 640 }), [640, 660]);
});

test("a pop-up is never smaller than 200 by 150 for its page", () => {
  assert.deepEqual(popupSize({ width: 50, height: 20 }), [200, 210]);
  assert.deepEqual(popupSize({ width: -10, height: 0 }), [200, 210]);
});

test("with no position asked, a pop-up is centred on its opener's window, 60 below its top", () => {
  assert.deepEqual(popupFrame({ width: 400, height: 300 }, OPENER), [500, 110, 400, 360]);
  assert.deepEqual(popupFrame({}, OPENER), [450, 110, 500, 660]);
});

test("a position the page asked for wins, and a missing coordinate comes from the opener", () => {
  assert.deepEqual(popupFrame({ x: 30, y: 40, width: 400, height: 300 }, OPENER), [30, 40, 400, 360]);
  assert.deepEqual(popupFrame({ x: 30, width: 400, height: 300 }, OPENER), [30, 110, 400, 360]);
  assert.deepEqual(popupFrame({ y: 40, width: 400, height: 300 }, OPENER), [500, 40, 400, 360]);
  assert.deepEqual(popupFrame({ x: 10.4, y: 20.6 }, null), [10, 21, 500, 660]);
});

test("with no opener window and no position, native code centres the pop-up on its display", () => {
  assert.equal(popupFrame({ width: 400, height: 300 }, null), null);
});

test("the origin strip shows the host for https and the scheme for the rest, as on the Mac", () => {
  assert.equal(popupOriginText("https://Accounts.Example.com/login?next=1"), "accounts.example.com");
  assert.equal(popupOriginText("https://example.com:8443/a"), "example.com:8443");
  assert.equal(popupOriginText("http://example.com/a"), "http://example.com");
  assert.equal(popupOriginText(""), "about:blank");
  assert.equal(popupOriginText("about:blank"), "about:blank");
  assert.equal(popupOriginText("data:text/html,<p>hi</p>"), "data:");
  assert.equal(popupOriginText("blob:https://example.com/1234"), "blob:https://example.com");
  assert.equal(popupOriginText("file:///C:/page.html"), "file:///C:/page.html");
});

test("the lock follows the engine's security level, else the scheme", () => {
  assert.equal(popupSecurity("https://example.com", "secure"), "secure");
  assert.equal(popupSecurity("https://example.com", "certificateError"), "certificateError");
  assert.equal(popupSecurity("https://example.com", "mixed"), "notSecure");
  assert.equal(popupSecurity("http://example.com", null), "notSecure");
  assert.equal(popupSecurity("https://example.com", null), "unknown");
  assert.equal(popupSecurity("about:blank", null), "local");
});

test("the window title is the page title, or the origin while the page has none", () => {
  assert.equal(popupTitle("Sign in", "https://example.com/login"), "Sign in");
  assert.equal(popupTitle("", "https://example.com/login"), "example.com");
  assert.equal(popupTitle("https://example.com/login", "https://example.com/login"), "example.com");
});
