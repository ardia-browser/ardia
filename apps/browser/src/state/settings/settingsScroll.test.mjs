import assert from "node:assert/strict";
import { test } from "node:test";
const { forgetSettingsScroll, goToSettingsPane, noteSettingsScrollOffset, replaceSettingsPlace, settingsBack, settingsForward, useSettingsNav } = await import("./settingsWindows.ts");
const { settingsScrollFor } = await import("./settingsWindows.ts");
const { paneScroll } = await import("./paneScroll.ts");
const mount = () => paneScroll(nav().visit, settingsScrollFor(nav().visit));

const nav = () => useSettingsNav.getState();
const scrollShown = (y) => noteSettingsScrollOffset(nav().visit, y);

function fresh() {
  useSettingsNav.setState({ pane: "general", profileId: null, detail: null, scroll: 0, visit: 0, back: [], forward: [] });
  noteSettingsScrollOffset(-1, 0);
}

test("Back returns to the parent pane where it was left, Forward to the sub-page's own spot", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(520);
  goToSettingsPane("profiles", "default", "passwords");
  assert.equal(nav().scroll, 0);
  scrollShown(240);
  settingsBack();
  assert.equal(nav().detail, null);
  assert.equal(nav().scroll, 520);
  settingsForward();
  assert.equal(nav().detail, "passwords");
  assert.equal(nav().scroll, 240);
});

test("each pane keeps its own position across several steps", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("general", null, "crashDetails");
  scrollShown(90);
  goToSettingsPane("plugins");
  scrollShown(300);
  goToSettingsPane("plugins", null, "some-plugin");
  settingsBack();
  assert.equal(nav().scroll, 300);
  settingsBack();
  assert.equal(nav().scroll, 90);
  settingsBack();
  assert.equal(nav().pane, "general");
  assert.equal(nav().scroll, 700);
});

test("a pane opened fresh starts at the top", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("tabs");
  assert.equal(nav().scroll, 0);
  goToSettingsPane("general");
  assert.equal(nav().scroll, 0);
});

test("two profiles' overviews are separate history entries with their own positions", () => {
  fresh();
  goToSettingsPane("profiles", "work");
  scrollShown(500);
  const work = nav().visit;
  goToSettingsPane("profiles", "home");
  assert.notEqual(nav().visit, work);
  scrollShown(80);
  settingsBack();
  assert.equal(nav().profileId, "work");
  assert.equal(nav().visit, work);
  assert.equal(nav().scroll, 500);
  settingsForward();
  assert.equal(nav().profileId, "home");
  assert.equal(nav().scroll, 80);
});

test("an offset noted for one visit is never taken for another visit of the same page", () => {
  fresh();
  goToSettingsPane("tabs");
  scrollShown(400);
  const stale = nav().visit;
  goToSettingsPane("general");
  goToSettingsPane("tabs");
  noteSettingsScrollOffset(stale, 999);
  settingsBack();
  settingsForward();
  assert.equal(nav().scroll, 0);
});

test("leaving a page saves where it actually is, not where it was meant to go back to", () => {
  fresh();
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(2400);
  goToSettingsPane("general");
  settingsBack();
  assert.equal(nav().scroll, 2400);
  scrollShown(310);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 310);
});

test("leaving a sub-page in place lands on the parent's spot", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(360);
  const parent = nav().visit;
  goToSettingsPane("profiles", "default", "extension:abc");
  replaceSettingsPlace("default", null);
  assert.equal(nav().scroll, 360);
  assert.equal(nav().visit, parent);
});

test("closing Settings forgets every entry's position", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(520);
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(200);
  goToSettingsPane("general");
  settingsBack();
  forgetSettingsScroll();
  const all = [nav(), ...nav().back, ...nav().forward];
  assert.ok(all.length >= 3);
  for (const stop of all) assert.equal(stop.scroll, 0, `${stop.pane}:${stop.detail}`);
  settingsBack();
  assert.equal(nav().scroll, 0);
  settingsForward();
  settingsForward();
  assert.equal(nav().scroll, 0);
});

function returnToSaved(y) {
  fresh();
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(y);
  goToSettingsPane("general");
  settingsBack();
}

test("the saved offset is restored when the page first lays out tall enough to reach it", () => {
  returnToSaved(800);
  const pane = mount();
  assert.equal(pane.firstLayout(600, 1400), 800);
  assert.equal(pane.firstLayout(600, 3000), null);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 800);
});

test("a page too short for its saved offset at first layout stays at the top and never jumps later", () => {
  returnToSaved(2400);
  const pane = mount();
  assert.equal(pane.firstLayout(600, 900), 0);
  assert.equal(pane.firstLayout(600, 5000), null);
});

test("(a) leaving a page that never reached its saved offset saves where it really was", () => {
  returnToSaved(2400);
  const pane = mount();
  pane.firstLayout(600, 900);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 0);
});

test("(b) a user scroll after first layout is simply recorded: nothing is waiting to pull it back", () => {
  returnToSaved(2400);
  const pane = mount();
  pane.firstLayout(600, 900);
  pane.scrolled(300);
  assert.equal(pane.firstLayout(600, 5000), null);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 300);
});

test("(c) a queued scroll event from the page being left is never credited to the destination", () => {
  fresh();
  goToSettingsPane("tabs");
  const left = mount();
  left.firstLayout(600, 3000);
  left.scrolled(500);
  goToSettingsPane("advanced");
  const shown = mount();
  shown.scrolled(500);
  left.scrolled(650);
  shown.firstLayout(600, 3000);
  shown.scrolled(120);
  left.scrolled(700);
  settingsBack();
  assert.equal(nav().pane, "tabs");
  assert.equal(nav().scroll, 500);
  settingsForward();
  assert.equal(nav().scroll, 120);
});

test("scroll events before the destination's first layout are ignored", () => {
  fresh();
  goToSettingsPane("tabs");
  const pane = mount();
  pane.scrolled(900);
  goToSettingsPane("general");
  settingsBack();
  assert.equal(nav().scroll, 0);
});
