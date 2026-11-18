import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import {
  activeSteps,
  cancelOnboarding,
  chooseSource,
  confirmAnswer,
  finishOnboarding,
  onboardingCompletedAt,
  previewLive,
  questionsFor,
  QUESTIONS,
  redoOnboarding,
  resolveDraft,
  draftPreset,
  skipStep,
  sourcePatch,
  startOnboarding,
  useOnboarding,
} from "./onboarding.ts";
import { adoptSetupChoices } from "./setupCodeChoices.ts";
import { readSaved } from "./onboardingDocument.ts";

const S = () => useBrowser.getState();
const O = () => useOnboarding.getState();
const settle = () => useOnboarding.setState({ windowId: null, leaving: false, redo: false });

const ALL_STEPS = ["source", "layout", "tabs", "look", "searchPrivacy", "pins", "home", "outro"];
const asked = () => activeSteps().flatMap((step) => questionsFor(step).map((q) => q.id));

test("every browser walks the full set of steps, and a browser's preset skips only the questions it answers", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  assert.deepEqual(activeSteps().filter((s) => s !== "intro"), ALL_STEPS);
  const everything = asked();
  for (const source of ["chrome", "safari", "arc", "dia"]) {
    startOnboarding(id, "source");
    chooseSource(source);
    assert.deepEqual(activeSteps().filter((s) => s !== "intro"), ALL_STEPS.filter((s) => questionsFor(s).length > 0), source);
    const list = asked();
    for (const q of ["color", "frame", "crash", "pins", "default", "outro"]) assert.ok(list.includes(q), `${source} asks ${q}`);
    assert.ok(list.every((q) => everything.includes(q)), source);
  }
  settle();
});

test("Continue goes through the steps in order and Skip moves past the rest of a step", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  confirmAnswer("source", sourcePatch(), []);
  assert.equal(O().step, "layout");
  for (const step of ["layout", "tabs", "look", "searchPrivacy", "pins", "home"]) {
    assert.equal(O().step, step);
    skipStep();
  }
  assert.equal(O().step, "outro");
  settle();
});

test("skipping the source after picking a browser leaves its preset out, so every question is asked", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("chrome");
  chooseSource(null);
  skipStep();
  assert.equal(O().step, "layout");
  assert.equal(questionsFor("tabs").length, QUESTIONS.tabs.length);
  assert.deepEqual(questionsFor("searchPrivacy").map((q) => q.id), ["engine", "typed", "crash"]);
  settle();
});

test("after a setup code, every step asks its questions from the settings the code applied", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("chrome");
  adoptSetupChoices({ settings: { searchEngine: "kagi" }, preset: "dia" }, ["From a setup code"]);
  assert.equal(readSaved().source, null, "a relaunch resumes without the unconfirmed browser's preset");
  assert.equal(questionsFor("layout").length > 0, true);
  assert.deepEqual(questionsFor("searchPrivacy").map((q) => q.id), ["engine", "typed", "crash"]);
  S().updateSettings({ searchEngine: "kagi" });
  assert.equal(resolveDraft(["searchEngine"], O().draft, draftPreset(O()), S().settings, []).searchEngine, "kagi");
  settle();
});

test("redo starts from the current settings, keeps them unless a new browser is picked, and cancel undoes previews", () => {
  const id = S().createWindow();
  S().updateSettings({ appearance: "dark", searchEngine: "kagi", newTabOpens: "page", addressBar: "toolbar" });
  const completed = onboardingCompletedAt();
  assert.equal(redoOnboarding(id), id);
  assert.equal(O().step, "source");
  assert.equal(O().redo, true);
  const now = resolveDraft(["appearance", "searchEngine", "addressBar"], O().draft, draftPreset(O()), S().settings, []);
  assert.deepEqual(now, { appearance: "dark", searchEngine: "kagi", addressBar: "toolbar" });
  chooseSource(O().redoSource);
  assert.deepEqual(sourcePatch(), {});
  assert.equal(questionsFor("tabs").length, QUESTIONS.tabs.length, "a redo on the same browser asks every question");
  chooseSource(O().redoSource === "arc" ? "dia" : "arc");
  assert.ok(Object.keys(sourcePatch()).length > 0, "a different browser brings its preset");
  chooseSource(O().redoSource);
  previewLive({ appearance: "light" });
  assert.equal(S().settings.appearance, "light");
  cancelOnboarding();
  assert.equal(S().settings.appearance, "dark");
  assert.equal(S().settings.searchEngine, "kagi");
  assert.equal(onboardingCompletedAt(), completed, "redo never touches when onboarding was first finished");
  settle();
  assert.equal(redoOnboarding(id), id);
  finishOnboarding();
  assert.equal(onboardingCompletedAt(), completed);
  settle();
});
