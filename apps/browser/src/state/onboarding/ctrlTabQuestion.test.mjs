import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { DEFAULT_SETTINGS } from "../settings/settings.ts";
import { activeSteps, cancelOnboarding, chooseSource, confirmAnswer, finishOnboarding, goToStep, previewLive, questionsFor, QUESTIONS, redoOnboarding, resolveDraft, setOnboardingDraft, skipStep, startOnboarding, useOnboarding, draftPreset } from "./onboarding.ts";
import { ctrlTabAnswerOf, ctrlTabAnswerPatch } from "../../components/settings/ctrlTabChoices.ts";
import { usePlugins } from "../plugins/store.ts";

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const O = () => useOnboarding.getState();
const KEYS = ["tabSwitcherOrder", "tabSwitcherView"];
const settle = () => useOnboarding.setState({ windowId: null, leaving: false, redo: false });
function reset() {
  S().updateSettings({ tabSwitcherOrder: DEFAULT_SETTINGS.tabSwitcherOrder, tabSwitcherView: DEFAULT_SETTINGS.tabSwitcherView, shortcuts: {} });
  const { chosen, inferred } = S().settingsMeta;
  useBrowser.setState({ settingsMeta: { chosen: chosen.filter((k) => !KEYS.includes(k)), inferred } });
}
const shown = () => resolveDraft(KEYS, O().draft, draftPreset(O()), S().settings, S().settingsMeta.chosen);
const answer = () => ctrlTabAnswerOf(shown());
const live = () => ({ tabSwitcherOrder: S().settings.tabSwitcherOrder, tabSwitcherView: S().settings.tabSwitcherView });

function atCtrlTab(id) {
  goToStep("tabs", questionsFor("tabs").findIndex((q) => q.id === "ctrlTab"));
  assert.equal(questionsFor(O().step)[O().sub]?.id, "ctrlTab", String(id));
}

function pick(choice) {
  const patch = ctrlTabAnswerPatch(choice, shown().tabSwitcherView);
  setOnboardingDraft(patch);
  previewLive(patch);
}

test("the tabs step asks what ⌃Tab does, whichever browser you come from, and answers with the switcher's order and look", () => {
  assert.deepEqual(QUESTIONS.tabs.find((q) => q.id === "ctrlTab").keys, KEYS);
  const id = S().createWindow();
  for (const source of ["arc", "dia", "chrome", "safari", "firefox", "fresh", null]) {
    startOnboarding(id, "source");
    chooseSource(source);
    assert.ok(activeSteps().includes("tabs"), String(source));
    assert.ok(questionsFor("tabs").some((q) => q.id === "ctrlTab"), String(source));
  }
  settle();
});

test("choices made in Settings beat a browser's preset", () => {
  reset();
  S().updateSettings({ tabSwitcherOrder: "inOrder", tabSwitcherView: "none" });
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("arc");
  assert.equal(answer(), "step");
  settle();
  reset();
});

test("Arc, Dia, Vivaldi and Opera start on the recent tabs switcher; Chrome, Safari, Firefox and Zen step through tabs; a fresh start takes the default", () => {
  reset();
  const id = S().createWindow();
  for (const [source, expected] of [["arc", "switcher"], ["dia", "switcher"], ["vivaldi", "switcher"], ["opera", "switcher"], ["chrome", "step"], ["safari", "step"], ["firefox", "step"], ["edge", "step"], ["zen", "step"], ["fresh", "switcher"], [null, "switcher"]]) {
    startOnboarding(id, "source");
    chooseSource(source);
    assert.equal(answer(), expected, String(source));
  }
  assert.deepEqual(live(), { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" }, "a preset only shows until it's confirmed");
  settle();
});

test("confirming writes the order and look, never the shortcuts, and Settings reads it back", () => {
  reset();
  S().updateSettings({ shortcuts: { closeTab: ["w", "command", "shift"] } });
  const id = S().createWindow();
  for (const [choice, expected] of [["step", { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }], ["switcher", { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" }]]) {
    startOnboarding(id, "source");
    chooseSource("chrome");
    atCtrlTab(choice);
    pick(choice);
    confirmAnswer("ctrlTab", shown(), []);
    assert.deepEqual(live(), expected, choice);
    assert.ok(KEYS.every((k) => S().settingsMeta.chosen.includes(k)));
    finishOnboarding();
    assert.deepEqual(live(), expected, "finishing keeps a confirmed answer");
    settle();
  }
  assert.deepEqual(S().settings.shortcuts, { closeTab: ["w", "command", "shift"] }, "shortcuts are left alone");
  reset();
});

test("picking the recent switcher keeps a compact list you already chose", () => {
  assert.deepEqual(ctrlTabAnswerPatch("switcher", "compactList"), { tabSwitcherOrder: "recent", tabSwitcherView: "compactList" });
  assert.deepEqual(ctrlTabAnswerPatch("switcher", "none"), { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" });
  assert.equal(ctrlTabAnswerOf({ tabSwitcherOrder: "inOrder", tabSwitcherView: "compactList" }), null, "a mix made in Settings shows no card picked");
});

test("Skip and cancelling a redo put the switcher back", () => {
  reset();
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("chrome");
  atCtrlTab("skip");
  pick("step");
  assert.deepEqual(live(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, "the pick is live while onboarding is open");
  skipStep();
  assert.deepEqual(live(), { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" });
  settle();

  S().updateSettings({ tabSwitcherOrder: "inOrder", tabSwitcherView: "compactList" });
  assert.equal(redoOnboarding(id), id);
  chooseSource(O().redoSource);
  atCtrlTab("redo");
  assert.deepEqual(shown(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "compactList" }, "a redo starts from your current choice");
  pick("switcher");
  assert.deepEqual(live(), { tabSwitcherOrder: "recent", tabSwitcherView: "compactList" }, "the redo's pick is live");
  cancelOnboarding();
  assert.deepEqual(live(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "compactList" });
  settle();
  reset();
});
