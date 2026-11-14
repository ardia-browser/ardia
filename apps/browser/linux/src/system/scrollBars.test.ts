import assert from "node:assert/strict";
import { test } from "node:test";

const { desktopPrefersOverlay, scrollBarMode } = await import("./scrollBars.ts");

test("Thin always overlays; following Linux overlays unless the desktop turns overlay scrolling off", () => {
  assert.equal(scrollBarMode("thin", () => false), "overlay");
  assert.equal(scrollBarMode("system", () => true), "overlay");
  assert.equal(scrollBarMode("system", () => false), "classic");
});

test("the desktop says no through GNOME's overlay-scrolling key or GTK_OVERLAY_SCROLLING=0", () => {
  assert.equal(desktopPrefersOverlay({}, () => "true"), true);
  assert.equal(desktopPrefersOverlay({}, () => null), true);
  assert.equal(desktopPrefersOverlay({}, () => "false"), false);
  assert.equal(desktopPrefersOverlay({ GTK_OVERLAY_SCROLLING: "0" }, () => "true"), false);
});
