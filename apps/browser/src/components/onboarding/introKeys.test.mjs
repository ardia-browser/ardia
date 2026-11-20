import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { introHoldsKeyboard, nextIntroStop } from "./introKeys.ts";
import { PLATFORM_FEATURES as MAC_FEATURES } from "../../lib/platformFeatures.ts";
import { PLATFORM_FEATURES as WINDOWS_FEATURES } from "../../lib/platformFeatures.windows.ts";
import { PLATFORM_TERMS as MAC_TERMS } from "../../lib/platformTerms.ts";
import { PLATFORM_TERMS as WINDOWS_TERMS } from "../../lib/platformTerms.windows.ts";

const MUTE = 0;
const SKIP = 1;

test("Tab and Shift+Tab move between the intro's Mute and Skip and wrap, as on the Mac and in the intro's page", () => {
  assert.equal(nextIntroStop(-1, false, 2), MUTE, "Tab from nothing focused goes to Mute");
  assert.equal(nextIntroStop(-1, true, 2), SKIP, "Shift+Tab from nothing focused goes to Skip");
  assert.equal(nextIntroStop(MUTE, false, 2), SKIP);
  assert.equal(nextIntroStop(SKIP, false, 2), MUTE, "Tab wraps from Skip to Mute");
  assert.equal(nextIntroStop(MUTE, true, 2), SKIP, "Shift+Tab wraps from Mute to Skip");
  assert.equal(nextIntroStop(SKIP, true, 2), MUTE);
  assert.equal(nextIntroStop(7, false, 2), MUTE, "a stop that no longer exists counts as nothing focused");
});

test("on Windows the intro holds the keyboard while its own buttons show, so Tab never reaches the browser behind it", () => {
  assert.equal(WINDOWS_FEATURES.tabReachesUnderOverlays, true);
  assert.equal(MAC_FEATURES.tabReachesUnderOverlays, false, "the Mac's key view loop already stays in the intro");
  const windows = { tabReachesUnderOverlays: true };
  assert.equal(introHoldsKeyboard({ ...windows, live: false, leaving: false }), true, "the poster and its buttons: the intro holds the keys");
  assert.equal(introHoldsKeyboard({ ...windows, live: true, leaving: false }), false, "the meadow's page draws the buttons and takes the keyboard itself");
  assert.equal(introHoldsKeyboard({ ...windows, live: false, leaving: true }), false, "once it leaves, onboarding's card takes over");
  assert.equal(introHoldsKeyboard({ tabReachesUnderOverlays: false, live: false, leaving: false }), false);
});

test("the links step names apps from the platform it runs on", () => {
  assert.equal(MAC_TERMS.linkSourceApps, "Mail, Slack, Notes");
  assert.ok(!/\bNotes\b/.test(WINDOWS_TERMS.linkSourceApps), "Notes is the Mac's app");
  const step = readFileSync(new URL("HomeStep.tsx", import.meta.url), "utf8");
  assert.ok(step.includes("From ${PLATFORM_TERMS.linkSourceApps} and the rest."));
  assert.ok(!step.includes("Mail, Slack, Notes"));
});

test("Settings names the same kind of apps for a link from another app as the links step does", () => {
  assert.equal(MAC_TERMS.linkSourceExamples, "Discord, Slack or Mail");
  assert.equal(WINDOWS_TERMS.linkSourceExamples, "Outlook, Teams or Slack");
  for (const app of WINDOWS_TERMS.linkSourceExamples.split(/, | or /)) assert.ok(WINDOWS_TERMS.linkSourceApps.includes(app), `${app} is not in the links step's list`);
  const pane = readFileSync(new URL("../settings/panes/Tabs.tsx", import.meta.url), "utf8");
  assert.equal(pane.split("A link from ${PLATFORM_TERMS.linkSourceExamples} opens").length, 3);
  assert.ok(!pane.includes("Discord, Slack or Mail"));
});

test("the command bar's placement is spelled as the rest of the UI spells it", () => {
  for (const file of ["LayoutSteps.tsx", "../settings/panes/Appearance.tsx", "../settings/rows/appearanceRows.ts", "../../state/telemetry/copy.ts"]) {
    assert.ok(!/\bcentre\b/.test(readFileSync(new URL(file, import.meta.url), "utf8")), `${file} says "centre"`);
  }
});
