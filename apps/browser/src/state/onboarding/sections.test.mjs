import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { activeSteps, chooseSource, confirmAnswer, nextStep, previewLive, previousStep, questionsFor, skipStep, sourcePatch, startOnboarding, useOnboarding } from "./onboarding.ts";
import { currentPlace, currentSectionIndex, goToSection, onboardingSections, sectionIndexOf } from "./sections.ts";
import { usePlugins } from "../plugins/store.ts";

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const O = () => useOnboarding.getState();
const settle = () => useOnboarding.setState({ windowId: null, leaving: false, redo: false });
const ids = () => onboardingSections().map((s) => s.id);

test("the scroll holds one section per asked question, source first, in step order, and no intro", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  const sections = onboardingSections();
  assert.equal(sections[0].id, "source");
  assert.equal(sections.at(-1).id, "outro");
  assert.ok(!sections.some((s) => s.step === "intro"));
  const expected = activeSteps().flatMap((step) => (step === "intro" ? [] : questionsFor(step).map((q) => q.id)));
  assert.deepEqual(ids(), expected);
  for (const [i, s] of sections.entries()) assert.equal(questionsFor(s.step)[s.sub].id, s.id, `section ${i} names its question`);
  assert.ok(["pins", "default", "links"].every((q) => ids().includes(q)), "pins and home are sections of the scroll");
  settle();
});

test("a browser's preset drops the sections it answers, and the scroll keeps following the step state", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  const everything = ids();
  chooseSource("arc");
  const arc = ids();
  assert.ok(arc.length < everything.length);
  assert.ok(arc.every((q) => everything.includes(q)));
  confirmAnswer("source", sourcePatch(), []);
  const sections = onboardingSections();
  assert.equal(currentSectionIndex(sections), 1);
  assert.deepEqual(sections[1], { step: O().step, sub: O().sub, id: sections[1].id });
  settle();
});

test("Continue moves the active section down by one, Back up by one, through step boundaries", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  confirmAnswer("source", sourcePatch(), []);
  const sections = onboardingSections();
  for (let i = 1; i < sections.length - 1; i++) {
    assert.equal(currentSectionIndex(sections), i, `Continue reaches ${sections[i].id}`);
    nextStep();
  }
  assert.equal(currentSectionIndex(sections), sections.length - 1);
  for (let i = sections.length - 1; i > 1; i--) {
    previousStep();
    assert.equal(currentSectionIndex(sections), i - 1, `Back reaches ${sections[i - 1].id}`);
  }
  settle();
});

test("Skip in the scroll skips only the active question, and leaves the next one in the same step to answer", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  confirmAnswer("source", sourcePatch(), []);
  const sections = onboardingSections();
  const tidy = sections.findIndex((s) => s.id === "tidy");
  goToSection(sections[tidy]);
  useOnboarding.setState((s) => ({ draft: { ...s.draft, cleanUpInactiveTabsAfterMinutes: 60 } }));
  skipStep("question");
  assert.equal(O().step, "tabs");
  assert.equal(onboardingSections()[currentSectionIndex(onboardingSections())].id, sections[tidy + 1].id);
  assert.equal("cleanUpInactiveTabsAfterMinutes" in O().draft, false, "the skipped question's draft is dropped");
  skipStep();
  assert.equal(O().step, "look", "the old Skip still moves past the rest of the step");
  settle();
});

test("skipping a question that previewed live puts the window back", () => {
  const id = S().createWindow();
  S().updateSettings({ appearance: "dark" });
  startOnboarding(id, "source");
  chooseSource("fresh");
  const appearance = onboardingSections().find((s) => s.id === "appearance");
  goToSection(appearance);
  previewLive({ appearance: "light" });
  assert.equal(S().settings.appearance, "light");
  skipStep("question");
  assert.equal(S().settings.appearance, "dark");
  settle();
});

test("clicking an earlier section goes straight back to it, and an unknown place falls back to its step", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("fresh");
  confirmAnswer("source", sourcePatch(), []);
  const sections = onboardingSections();
  goToSection(sections[6]);
  const before = currentPlace();
  goToSection(sections[2]);
  assert.notEqual(currentPlace(), before);
  assert.equal(currentSectionIndex(sections), 2);
  assert.equal(sectionIndexOf(sections, "tabs", 99), sections.findIndex((s) => s.step === "tabs"));
  assert.equal(sectionIndexOf(sections, "intro", 0), 0);
  settle();
});

test("Back on the first section leaves the place unchanged, so the scroller snaps back", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  const before = currentPlace();
  previousStep();
  assert.equal(currentPlace(), before);
  settle();
});
