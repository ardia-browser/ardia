import assert from "node:assert/strict";
import test from "node:test";
import { deckSteps, NO_LAUNCH_ARGUMENTS, parseLaunchArguments } from "./launchArguments.ts";

test("with no arguments nothing is asked for, and the delays are Compose's 6 s and 1.5 s", () => {
  assert.equal(NO_LAUNCH_ARGUMENTS.isDemo, false);
  assert.equal(NO_LAUNCH_ARGUMENTS.browseDelayMs, 6000);
  assert.equal(NO_LAUNCH_ARGUMENTS.browseStepGapMs, 1500);
  assert.deepEqual(NO_LAUNCH_ARGUMENTS.browseSteps, []);
  assert.equal(NO_LAUNCH_ARGUMENTS.browseQuery, null);
});

test("a flag is on for any value but false, no and 0, as intent extras and iPhone launch arguments give them", () => {
  for (const on of [true, "true", "YES", "1", 1, "anything"]) assert.equal(parseLaunchArguments({ ArdiaDemo: on }).isDemo, true, String(on));
  for (const off of [false, "false", "No", "0", 0, null, undefined]) assert.equal(parseLaunchArguments({ ArdiaDemo: off }).isDemo, false, String(off));
});

test("text is trimmed and empty text is none, but a query and an overlay keep their spaces", () => {
  const parsed = parseLaunchArguments({ BrowseOpen: "  https://example.com/  ", ArdiaColor: "   ", BrowseQuery: "otters ", BrowseOverlay: " ot" });
  assert.equal(parsed.browseOpen, "https://example.com/");
  assert.equal(parsed.color, null);
  assert.equal(parsed.browseQuery, "otters ");
  assert.equal(parsed.browseOverlay, " ot");
});

test("-BrowseResearch opens Browse for Me on its trimmed query and -ArdiaVoiceHeard shows voice search having heard its words, outside demo mode too, and nothing when empty", () => {
  assert.equal(parseLaunchArguments({ BrowseResearch: "  mount everest height  " }).browseResearch, "mount everest height");
  assert.equal(parseLaunchArguments({ BrowseResearch: "   " }).browseResearch, null);
  assert.equal(NO_LAUNCH_ARGUMENTS.browseResearch, null);
  assert.equal(parseLaunchArguments({ ArdiaVoiceHeard: " otter facts " }).voiceHeard, "otter facts");
  assert.equal(NO_LAUNCH_ARGUMENTS.voiceHeard, null);
});

test("numbers, whole numbers and steps parse as Compose's do", () => {
  const parsed = parseLaunchArguments({ BrowseDelay: "2.5", BrowseTab: "3.9", BrowseDeckOpen: 2, BrowseSteps: "1, -1,x,2", BrowseStepGap: "0.75" });
  assert.equal(parsed.browseDelayMs, 2500);
  assert.equal(parsed.browseTab, 3);
  assert.equal(parsed.browseDeckOpen, 2);
  assert.deepEqual(parsed.browseSteps, [1, -1, 2]);
  assert.equal(parsed.browseStepGapMs, 750);
  assert.equal(parseLaunchArguments({ BrowseDelay: "soon" }).browseDelayMs, 6000);
});

test("the motion captures only work in demo mode", () => {
  const outside = parseLaunchArguments({ BrowsePagerFreeze: "0.4", BrowsePagerScript: true, BrowseLoadFreeze: "0.6" });
  assert.equal(outside.pagerFreeze, null);
  assert.equal(outside.pagerScript, false);
  assert.equal(outside.loadFreeze, null);
  const demo = parseLaunchArguments({ ArdiaDemo: "YES", BrowsePagerFreeze: "-0.4", BrowsePagerScript: "YES", BrowseLoadFreeze: "0.6" });
  assert.equal(demo.pagerFreeze, -0.4);
  assert.equal(demo.pagerScript, true);
  assert.equal(demo.loadFreeze, 0.6);
});

test("a deck script splits into steps with their arguments", () => {
  assert.deepEqual(deckSteps(" warm, deck ,wait:1.5,,scroll:-2"), [
    { kind: "warm", argument: null },
    { kind: "deck", argument: null },
    { kind: "wait", argument: "1.5" },
    { kind: "scroll", argument: "-2" },
  ]);
});

test("the lab's one-container deck scroll is off unless ArdiaOneContainerScroll asks for it", () => {
  assert.equal(NO_LAUNCH_ARGUMENTS.oneContainerScroll, false);
  assert.equal(parseLaunchArguments({ ArdiaOneContainerScroll: "1" }).oneContainerScroll, true);
  assert.equal(parseLaunchArguments({ ArdiaOneContainerScroll: "NO" }).oneContainerScroll, false);
  assert.equal(parseLaunchArguments({ ArdiaOpeningCard: "1" }).oneContainerScroll, false);
});

test("the lab's collapsed pill holds its sample through a scroll only when ArdiaPillHold asks for it", () => {
  assert.equal(NO_LAUNCH_ARGUMENTS.pillHold, false);
  assert.equal(parseLaunchArguments({ ArdiaPillHold: true }).pillHold, true);
  assert.equal(parseLaunchArguments({ ArdiaPillHold: "false" }).pillHold, false);
  assert.equal(parseLaunchArguments({ PillHold: true }).pillHold, false);
});

test("the lab's redesigned Android is off unless ArdiaRedesign asks for it", () => {
  assert.equal(NO_LAUNCH_ARGUMENTS.redesign, false);
  assert.equal(parseLaunchArguments({ ArdiaRedesign: "YES" }).redesign, true);
  assert.equal(parseLaunchArguments({ ArdiaRedesign: "0" }).redesign, false);
});

test("the lab's demo seed scale is read only in a demo session, and never below zero", () => {
  assert.equal(NO_LAUNCH_ARGUMENTS.demoScale, 0);
  assert.equal(parseLaunchArguments({ ArdiaDemo: "YES", ArdiaDemoScale: "1000" }).demoScale, 1000);
  assert.equal(parseLaunchArguments({ ArdiaDemoScale: "1000" }).demoScale, 0);
  assert.equal(parseLaunchArguments({ ArdiaDemo: "YES", ArdiaDemoScale: "-5" }).demoScale, 0);
});
