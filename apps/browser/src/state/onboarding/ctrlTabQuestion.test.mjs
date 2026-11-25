import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { chooseCtrlTab, ctrlTabChoice } from "../commands/commandShortcuts.ts";
import { activeSteps, cancelOnboarding, chooseSource, confirmAnswer, finishOnboarding, goToStep, questionsFor, QUESTIONS, redoOnboarding, skipStep, startOnboarding, useOnboarding } from "./onboarding.ts";
import { ctrlTabAnswerPatch, onboardingCtrlTab, pickOnboardingCtrlTab } from "./ctrlTabAnswer.ts";
import { usePlugins } from "../plugins/store.ts";

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const O = () => useOnboarding.getState();
const settle = () => useOnboarding.setState({ windowId: null, leaving: false, redo: false });
const reset = () => S().updateSettings({ shortcuts: {} });

function settingsWouldWrite(preset) {
  const before = S().settings.shortcuts;
  chooseCtrlTab(preset);
  const written = S().settings.shortcuts;
  S().updateSettings({ shortcuts: before });
  return written;
}

function atCtrlTab(id) {
  goToStep("tabs", questionsFor("tabs").findIndex((q) => q.id === "ctrlTab"));
  assert.equal(questionsFor(O().step)[O().sub]?.id, "ctrlTab", String(id));
}

test("the tabs step asks what ⌃Tab does, whichever browser you come from", () => {
  assert.ok(QUESTIONS.tabs.some((q) => q.id === "ctrlTab"));
  assert.deepEqual(QUESTIONS.tabs.find((q) => q.id === "ctrlTab").keys, ["shortcuts"]);
  const id = S().createWindow();
  for (const source of ["arc", "dia", "chrome", "safari", "firefox", "fresh", null]) {
    startOnboarding(id, "source");
    chooseSource(source);
    assert.ok(activeSteps().includes("tabs"), String(source));
    assert.ok(questionsFor("tabs").some((q) => q.id === "ctrlTab"), String(source));
  }
  settle();
});

test("coming from Arc or Dia starts on the recent tabs switcher; Chrome, Safari, Firefox and a fresh start step through tabs", () => {
  reset();
  const id = S().createWindow();
  for (const [source, expected] of [["arc", "switcher"], ["dia", "switcher"], ["chrome", "step"], ["safari", "step"], ["firefox", "step"], ["edge", "step"], ["fresh", "step"], [null, "step"]]) {
    startOnboarding(id, "source");
    chooseSource(source);
    assert.equal(onboardingCtrlTab(), expected, String(source));
  }
  assert.equal(ctrlTabChoice(), "step", "a preset only shows until it's confirmed");
  settle();
});

test("confirming the answer writes the same shortcut overrides the Settings cards write, and Settings reads it back", () => {
  reset();
  S().updateSettings({ shortcuts: { closeTab: ["w", "command", "shift"] } });
  const id = S().createWindow();
  for (const preset of ["switcher", "step"]) {
    const expected = settingsWouldWrite(preset);
    startOnboarding(id, "source");
    chooseSource("chrome");
    atCtrlTab(preset);
    pickOnboardingCtrlTab(preset);
    assert.equal(onboardingCtrlTab(), preset);
    confirmAnswer("ctrlTab", ctrlTabAnswerPatch(onboardingCtrlTab()), []);
    assert.deepEqual(S().settings.shortcuts, expected, preset);
    assert.equal(ctrlTabChoice(), preset, `Settings shows ${preset}`);
    assert.ok(S().settingsMeta.chosen.includes("shortcuts"));
    finishOnboarding();
    assert.deepEqual(S().settings.shortcuts, expected, "finishing keeps a confirmed answer");
    settle();
  }
  assert.deepEqual(S().settings.shortcuts.closeTab, ["w", "command", "shift"], "unrelated shortcuts survive");
  reset();
});

test("an Arc preset confirmed without a press binds the switcher", () => {
  reset();
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("arc");
  atCtrlTab("arc");
  confirmAnswer("ctrlTab", ctrlTabAnswerPatch(onboardingCtrlTab()), []);
  assert.equal(ctrlTabChoice(), "switcher");
  settle();
  reset();
});

test("a pick previews live; Skip, finishing without confirming, and cancelling a redo all put ⌃Tab back", () => {
  reset();
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("chrome");
  atCtrlTab("skip");
  pickOnboardingCtrlTab("switcher");
  assert.equal(ctrlTabChoice(), "switcher", "the pick is live while onboarding is open");
  skipStep();
  assert.equal(ctrlTabChoice(), "step");
  assert.equal("shortcuts" in O().draft, false);
  settle();

  startOnboarding(id, "source");
  chooseSource("chrome");
  atCtrlTab("finish");
  pickOnboardingCtrlTab("switcher");
  finishOnboarding();
  assert.equal(ctrlTabChoice(), "step");
  settle();

  chooseCtrlTab("switcher");
  const mine = S().settings.shortcuts;
  assert.equal(redoOnboarding(id), id);
  chooseSource(O().redoSource);
  atCtrlTab("redo");
  assert.equal(onboardingCtrlTab(), "switcher", "a redo starts from your current choice");
  pickOnboardingCtrlTab("step");
  assert.equal(ctrlTabChoice(), "step");
  pickOnboardingCtrlTab("switcher");
  pickOnboardingCtrlTab("step");
  cancelOnboarding();
  assert.equal(ctrlTabChoice(), "switcher");
  assert.deepEqual(S().settings.shortcuts, mine);
  settle();
  reset();
});

test("custom ⌃Tab keys stay as they are unless you pick a card", () => {
  reset();
  S().updateSettings({ shortcuts: { newTab: ["\t", "control"] } });
  assert.equal(ctrlTabChoice(), "custom");
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("arc");
  atCtrlTab("custom");
  assert.equal(onboardingCtrlTab(), "custom");
  assert.deepEqual(ctrlTabAnswerPatch(onboardingCtrlTab()), {});
  confirmAnswer("ctrlTab", ctrlTabAnswerPatch(onboardingCtrlTab()), []);
  assert.deepEqual(S().settings.shortcuts, { newTab: ["\t", "control"] });
  settle();
  reset();
});
