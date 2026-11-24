import assert from "node:assert/strict";
import { test } from "node:test";
import { currentScreenLayout, PHONE_LAYOUT, reportScreenLayout, screenLayoutOf, useScreenLayout } from "./screenLayout.ts";

test("the native report maps to a layout, and anything incomplete or missing stays the phone layout", () => {
  assert.deepEqual(screenLayoutOf(null), PHONE_LAYOUT);
  assert.deepEqual(screenLayoutOf({ layout: "split", fold: { top: 440, bottom: 520 } }), { name: "split", fold: { top: 440, bottom: 520 } });
  assert.deepEqual(screenLayoutOf({ layout: "split" }), PHONE_LAYOUT);
  assert.deepEqual(screenLayoutOf({ layout: "wide" }), { name: "wide" });
  assert.deepEqual(screenLayoutOf({ layout: "phone" }), PHONE_LAYOUT);
});

test("the report's hinge is kept, so a closed or open Duo on the phone layout is still known as a Duo", () => {
  reportScreenLayout({ layout: "phone", space: { hinge: "closed" } });
  assert.equal(useScreenLayout.getState().hinge, "closed");
  assert.deepEqual(currentScreenLayout(), PHONE_LAYOUT);
  reportScreenLayout({ layout: "phone", space: { hinge: "fullyOpen" } });
  assert.equal(useScreenLayout.getState().hinge, "fullyOpen");
  reportScreenLayout({ layout: "phone" });
  assert.equal(useScreenLayout.getState().hinge, "none");
  useScreenLayout.setState({ layout: PHONE_LAYOUT, hinge: "none" });
});

test("an unchanged report keeps the same layout object, so nothing re-renders for it", () => {
  reportScreenLayout({ layout: "split", fold: { top: 440, bottom: 520 } });
  const first = currentScreenLayout();
  reportScreenLayout({ layout: "split", fold: { top: 440, bottom: 520 } });
  assert.equal(currentScreenLayout(), first);
  reportScreenLayout({ layout: "wide" });
  assert.deepEqual(currentScreenLayout(), { name: "wide" });
  useScreenLayout.setState({ layout: PHONE_LAYOUT, hinge: "none" });
});
