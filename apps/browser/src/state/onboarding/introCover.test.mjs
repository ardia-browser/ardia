import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { windows } from "../../test-native/shell.ts";
import { closeIntroWindowFor, coverOrReveal, coverScreenForIntro, handOffFromIntro, holdWindowHidden, uncoverScreen } from "./introCover.ts";
import { INTRO_WINDOW_ID } from "./introWindow.ts";
import { goToStep, startOnboarding, useOnboarding } from "./onboarding.ts";

test("a cover opened again right after the last one was let go stays open past the old linger", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    coverScreenForIntro(id);
    assert.equal(windows.open.get(INTRO_WINDOW_ID)?.cover, id, "the cover names the browser window it covers");
    uncoverScreen(id);
    coverScreenForIntro(id);
    mock.timers.tick(5000);
    assert.ok(windows.open.has(INTRO_WINDOW_ID), "the new cover is still open");
    uncoverScreen(id);
    mock.timers.tick(5000);
    assert.ok(!windows.open.has(INTRO_WINDOW_ID), "the cover closes once it is let go for good");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("the hand-off from one session's intro doesn't move a newer session past its intro", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    handOffFromIntro(false);
    startOnboarding(id, "intro");
    mock.timers.tick(5000);
    assert.equal(useOnboarding.getState().step, "intro");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("a new session's intro in the reused cover window isn't closed or handed off by the old session's intro", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    const first = useOnboarding.getState().session;
    coverScreenForIntro(id);
    startOnboarding(id, "intro");
    const second = useOnboarding.getState().session;
    coverScreenForIntro(id);
    handOffFromIntro(false, first);
    closeIntroWindowFor(first);
    mock.timers.tick(5000);
    assert.ok(windows.open.has(INTRO_WINDOW_ID), "the new session's cover is still open");
    assert.equal(useOnboarding.getState().step, "intro", "the new session is still on its intro");
    closeIntroWindowFor(second);
    assert.ok(!windows.open.has(INTRO_WINDOW_ID), "the new session's own intro closes it");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("an intro that doesn't cover the screen shows the browser window the intro hold hid", () => {
  const id = useBrowser.getState().createWindow();
  holdWindowHidden(id);
  assert.equal(windows.shown.get(id), false);
  const before = windows.open.has(INTRO_WINDOW_ID);
  assert.equal(coverOrReveal(id, false, 15000), undefined);
  assert.equal(windows.shown.get(id), true, "the held browser window is shown again");
  assert.equal(windows.open.has(INTRO_WINDOW_ID), before, "no cover opens");
});

test("an intro that covers the screen keeps the browser window hidden until the cover is let go", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    holdWindowHidden(id);
    const release = coverOrReveal(id, true, 15000);
    assert.equal(windows.shown.get(id), false);
    assert.ok(windows.open.has(INTRO_WINDOW_ID));
    release();
    assert.equal(windows.shown.get(id), true);
    mock.timers.tick(5000);
  } finally {
    mock.timers.reset();
  }
});

test("a full-screen intro still on its intro past the deadline shows the browser window and moves on, once, for its own session", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    holdWindowHidden(id);
    coverOrReveal(id, true, 15000);
    mock.timers.tick(14000);
    assert.equal(useOnboarding.getState().step, "intro");
    assert.equal(windows.shown.get(id), false);
    mock.timers.tick(2000);
    assert.equal(windows.shown.get(id), true, "the held browser window is shown");
    mock.timers.tick(500);
    assert.equal(useOnboarding.getState().step, "source", "onboarding moves on to the first question");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("an intro that hands off before the deadline isn't moved on again when the deadline passes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    holdWindowHidden(id);
    const release = coverOrReveal(id, true, 15000);
    mock.timers.tick(3000);
    handOffFromIntro(false);
    mock.timers.tick(1000);
    assert.equal(useOnboarding.getState().step, "source");
    goToStep("layout");
    windows.shown.set(id, false);
    mock.timers.tick(20000);
    assert.equal(useOnboarding.getState().step, "layout", "the deadline doesn't move a session that already left its intro");
    assert.equal(windows.shown.get(id), false, "the deadline doesn't show the window again");
    release();
    startOnboarding(id, "intro");
    const next = coverOrReveal(id, true, 15000);
    next();
    mock.timers.tick(20000);
    assert.equal(useOnboarding.getState().step, "intro", "a released cover's deadline is cancelled");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});
