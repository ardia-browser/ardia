import assert from "node:assert/strict";
import { test } from "node:test";
const { keyBarPlacement, isCentred, commandKeyPlacement, addressFieldShown, clickBarPlacement, placementCard, placementFromCard } = await import("./barPlacement.ts");
const { openBarFromAddress, openEmptySidebarField } = await import("./barState.ts");
const { commandBarPlacementLabel } = await import("../telemetry/track.ts");
const { useBrowser } = await import("../browser/store.ts");

test("⌘L opens at the field when one is on screen, as a click does", () => {
  assert.equal(keyBarPlacement({ setting: "field", small: false, fieldShown: true }), "field");
});

test("⌘L falls back to the centre when no field is on screen", () => {
  assert.equal(keyBarPlacement({ setting: "field", small: false, fieldShown: false }), "centredNoField");
  assert.ok(isCentred("centredNoField"));
});

test("the In the centre setting still sends ⌘L to the centre", () => {
  assert.equal(keyBarPlacement({ setting: "centred", small: false, fieldShown: true }), "centred");
  assert.equal(keyBarPlacement({ setting: "centred", small: false, fieldShown: false }), "centred");
});

test("Little Ardia keeps its own dropdown", () => {
  assert.equal(keyBarPlacement({ setting: "centred", small: true, fieldShown: false }), "field");
});

const S = () => useBrowser.getState();
const pageWindow = (settings) => {
  S().hydrate({});
  S().updateSettings(settings);
  return S().createWindow({ url: "https://example.com/" });
};

test("with In the centre, a click on the address still opens at the field", () => {
  const w = pageWindow({ commandBarPlacement: "centred" });
  S().openPanel(w, "https://example.com/");
  assert.equal(S().windowUi[w].panel.placement, "field");
  assert.equal(commandBarPlacementLabel(S().windowUi[w].panel), "field");
});

test("In the centre, also on click sends a click on the address to the centre, as ⌘L, except in Little Ardia", () => {
  assert.equal(keyBarPlacement({ setting: "centredOnClick", small: false, fieldShown: true }), "centred");
  assert.equal(keyBarPlacement({ setting: "centredOnClick", small: true, fieldShown: true }), "field");
  let w = pageWindow({ commandBarPlacement: "centredOnClick" });
  assert.equal(commandKeyPlacement(S(), w), "centred");
  openBarFromAddress(w, "https://example.com/");
  assert.equal(S().windowUi[w].panel.placement, "centred");
  assert.equal(S().windowUi[w].panel.initialText, "https://example.com/");
  w = pageWindow({ commandBarPlacement: "centredOnClick", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false });
  openEmptySidebarField(w);
  assert.equal(S().windowUi[w].panel.placement, "centred");
  assert.equal(clickBarPlacement({ settings: { commandBarPlacement: "centredOnClick" }, windows: { little: { kind: "small" } } }, "little"), "field");
});

test("onboarding's two cards show In the centre for the click choice too, and picking it again keeps the click part", () => {
  assert.equal(placementCard("field"), "field");
  assert.equal(placementCard("centred"), "centred");
  assert.equal(placementCard("centredOnClick"), "centred");
  assert.equal(placementFromCard("centred", "centredOnClick"), "centredOnClick");
  assert.equal(placementFromCard("field", "centredOnClick"), "field");
  assert.equal(placementFromCard("centred", "field"), "centred");
  assert.equal(placementFromCard("centred", "centred"), "centred");
});

test("with At the address or In the centre, a click on the address opens at the field", () => {
  for (const commandBarPlacement of ["field", "centred"]) {
    const w = pageWindow({ commandBarPlacement });
    openBarFromAddress(w, "https://example.com/");
    assert.equal(S().windowUi[w].panel.placement, "field", commandBarPlacement);
  }
});

test("⌘L in each layout", () => {
  let w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  assert.equal(commandKeyPlacement(S(), w), "field");
  w = pageWindow({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false });
  assert.equal(commandKeyPlacement(S(), w), "field");
  w = pageWindow({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: true });
  assert.equal(addressFieldShown(S(), w), false);
  assert.equal(commandKeyPlacement(S(), w), "centredNoField");
  w = pageWindow({ commandBarPlacement: "centred", addressBar: "toolbar" });
  assert.equal(commandKeyPlacement(S(), w), "centred");
});

test("⌘L on a page puts that presentation on the panel", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w });
  assert.equal(S().windowUi[w].panel.open, true);
  assert.equal(S().windowUi[w].panel.placement, "field");
  assert.equal(S().windowUi[w].panel.initialText, "https://example.com/");
});

test("labels the presentation for telemetry", () => {
  assert.equal(commandBarPlacementLabel({ placement: "field" }), "field");
  assert.equal(commandBarPlacementLabel({}), "field");
  assert.equal(commandBarPlacementLabel({ placement: "centred" }), "centred");
  assert.equal(commandBarPlacementLabel({ placement: "centredNoField" }), "centred_no_field");
  assert.equal(commandBarPlacementLabel({ newTab: { kind: "list" }, placement: "field" }), "new_tab");
});

test("an unknown window has no field and ⌘L there goes to the centre", () => {
  const s = useBrowser.getState();
  assert.equal(addressFieldShown(s, "nope"), false);
  assert.equal(commandKeyPlacement(s, "nope"), "centredNoField");
});
