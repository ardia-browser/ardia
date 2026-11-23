import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceSummary, appearanceTelemetry, appliedDark, chromeStyle, glassRenderTelemetry, macLookOf, preferredScheme, resolvedInterfaceStyle, type MacLook } from "./appearance.ts";

const classicDarkMac: MacLook = { interfaceStyle: "classic", appearance: "dark" };
const glassLightMac: MacLook = { interfaceStyle: "glass", appearance: "light" };
const autoMac: MacLook = { interfaceStyle: null, appearance: "auto" };

test("the Mac's look counts only while sync is on, and an absent look is none", () => {
  assert.equal(macLookOf(false, classicDarkMac), null);
  assert.equal(macLookOf(true, classicDarkMac), classicDarkMac);
  assert.equal(macLookOf(true, undefined), null);
  assert.equal(macLookOf(true, null), null);
});

test("Match My Mac takes the Mac's Glass or Classic and is Glass without a Mac, as main's resolvedInterfaceStyle", () => {
  assert.equal(resolvedInterfaceStyle("matchMac", classicDarkMac), "classic");
  assert.equal(resolvedInterfaceStyle("matchMac", glassLightMac), "glass");
  assert.equal(resolvedInterfaceStyle("matchMac", autoMac), "glass");
  assert.equal(resolvedInterfaceStyle("matchMac", null), "glass");
  assert.equal(resolvedInterfaceStyle("glass", classicDarkMac), "glass");
  assert.equal(resolvedInterfaceStyle("classic", glassLightMac), "classic");
});

test("the redesign's surfaces are Glass only when the style resolves to Glass and Reduce Transparency is off", () => {
  assert.equal(chromeStyle("redesigned", "glass", null, false), "glass");
  assert.equal(chromeStyle("redesigned", "glass", null, true), "classic");
  assert.equal(chromeStyle("redesigned", "classic", null, false), "classic");
  assert.equal(chromeStyle("redesigned", "matchMac", classicDarkMac, false), "classic");
  assert.equal(chromeStyle("redesigned", "matchMac", glassLightMac, true), "classic");
});

test("the original design ignores both choices: its surfaces stay as they were and it follows the system's light or dark", () => {
  assert.equal(chromeStyle("original", "classic", classicDarkMac, true), "glass");
  assert.equal(preferredScheme("original", "dark", null), null);
  assert.equal(preferredScheme("original", "matchMac", classicDarkMac), null);
});

test("Light or Dark: a fixed choice wins, System follows the device, Match My Mac takes the Mac's light or dark and the device's when the Mac is on auto or absent", () => {
  assert.equal(preferredScheme("redesigned", "light", classicDarkMac), "light");
  assert.equal(preferredScheme("redesigned", "dark", null), "dark");
  assert.equal(preferredScheme("redesigned", "system", classicDarkMac), null);
  assert.equal(preferredScheme("redesigned", "matchMac", classicDarkMac), "dark");
  assert.equal(preferredScheme("redesigned", "matchMac", glassLightMac), "light");
  assert.equal(preferredScheme("redesigned", "matchMac", autoMac), null);
  assert.equal(preferredScheme("redesigned", "matchMac", null), null);
  assert.equal(appliedDark(null, true), true);
  assert.equal(appliedDark(null, false), false);
  assert.equal(appliedDark("light", true), false);
  assert.equal(appliedDark("dark", false), true);
});

test("the Appearance row's summary lists the chosen colour, style and scheme, and reads Match My Mac when nothing is chosen, as main's AppearanceSummary", () => {
  assert.equal(appearanceSummary(null, "matchMac", "matchMac"), "Match My Mac");
  assert.equal(appearanceSummary("Blue", "matchMac", "matchMac"), "Blue");
  assert.equal(appearanceSummary(null, "classic", "matchMac"), "Classic");
  assert.equal(appearanceSummary("Green", "glass", "dark"), "Green, Glass, Dark");
  assert.equal(appearanceSummary(null, "matchMac", "system"), "System");
});

test("telemetry carries the two choices as fixed words", () => {
  assert.deepEqual(appearanceTelemetry("matchMac", "matchMac"), { interface_style: "match_mac", color_scheme: "match_mac" });
  assert.deepEqual(appearanceTelemetry("classic", "system"), { interface_style: "classic", color_scheme: "system" });
  assert.deepEqual(appearanceTelemetry("glass", "dark"), { interface_style: "glass", color_scheme: "dark" });
});

test("each launch says how the glass is drawn: Android's lens, frost or solid, Classic, iPhone's own, or no glass in Material You", () => {
  assert.equal(glassRenderTelemetry("android", "redesigned", "glass", "lens"), "lens");
  assert.equal(glassRenderTelemetry("android", "redesigned", "glass", "frost"), "frost");
  assert.equal(glassRenderTelemetry("android", "redesigned", "glass", "solid"), "solid");
  assert.equal(glassRenderTelemetry("android", "redesigned", "glass", null), "solid", "no native look module draws the flat fallback");
  assert.equal(glassRenderTelemetry("android", "redesigned", "classic", "lens"), "classic");
  assert.equal(glassRenderTelemetry("ios", "redesigned", "glass", null), "native");
  assert.equal(glassRenderTelemetry("ios", "redesigned", "classic", null), "classic");
  assert.equal(glassRenderTelemetry("android", "material", "glass", "lens"), "none");
});
