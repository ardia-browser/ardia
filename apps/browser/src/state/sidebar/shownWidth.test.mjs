import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SIDEBAR_WIDTH, MIN_WINDOW_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, shownSidebarWidth, sidebarWidthLimit } = await import("../../lib/windowLayout.ts");
const { keptSidebarWidth, savedSidebarWidth, sidebarWidthFollowsText, sidebarWidthIn } = await import("./shownWidth.ts");
const { resetSidebarWidth } = await import("./actions.ts");
const { forgetWindowRootSize, setWindowRootSize } = await import("../windows/rootSize.ts");
const { useInterfaceScale } = await import("../settings/interfaceScale.ts");

const S = () => useBrowser.getState();

test("at the window's minimum width the sidebar shows at most its default width, and the page keeps the rest", () => {
  assert.equal(sidebarWidthLimit(MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(DEFAULT_SIDEBAR_WIDTH, MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, MIN_WINDOW_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, 600), 290);
  assert.equal(shownSidebarWidth(SIDEBAR_MAX_WIDTH, 720), SIDEBAR_MAX_WIDTH);
  assert.equal(shownSidebarWidth(SIDEBAR_MIN_WIDTH, MIN_WINDOW_WIDTH), SIDEBAR_MIN_WIDTH);
  assert.equal(shownSidebarWidth(300, undefined), 300);
  assert.equal(sidebarWidthLimit(400), SIDEBAR_MIN_WIDTH);
});

test("a window's live width caps its sidebar while the saved width stays, and other windows keep theirs", () => {
  S().updateSettings({ sidebarWidth: 400 });
  const narrow = S().createWindow({ url: "https://narrow.example/", frame: [80, 80, 500, 620] });
  const wide = S().createWindow({ url: "https://wide.example/", frame: [80, 80, 1200, 800] });
  assert.equal(sidebarWidthIn(S(), narrow), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthIn(S(), wide), 400);
  setWindowRootSize(wide, 560, 700);
  assert.equal(sidebarWidthIn(S(), wide), 250, "the live layout width wins over the last reported frame");
  forgetWindowRootSize(wide);
  assert.equal(sidebarWidthIn(S(), wide), 400);
  assert.equal(S().settings.sidebarWidth, 400);
});

test("a window's frame is physical, so at a larger interface size its sidebar room is the frame divided by the scale", () => {
  S().updateSettings({ sidebarWidth: 400 });
  const id = S().createWindow({ url: "https://scaled.example/", frame: [80, 80, 900, 700] });
  assert.equal(sidebarWidthIn(S(), id), 400);
  useInterfaceScale.setState({ scale: 1.5 });
  try {
    assert.equal(sidebarWidthIn(S(), id), 600 - (MIN_WINDOW_WIDTH - DEFAULT_SIDEBAR_WIDTH), "900 window points are 600 root points at 150%");
    setWindowRootSize(id, 600, 466);
    assert.equal(sidebarWidthIn(S(), id), 290, "the root's own layout width agrees with the frame");
    forgetWindowRootSize(id);
  } finally {
    useInterfaceScale.setState({ scale: 1 });
  }
  assert.equal(S().settings.sidebarWidth, 400, "the saved width is root points and never changes with the scale");
});

test("a drag that ends at the window's limit keeps the wider saved width, and a narrower drag is saved", () => {
  assert.equal(keptSidebarWidth(190, 190, 400), 400);
  assert.equal(keptSidebarWidth(175, 190, 400), 175);
  assert.equal(keptSidebarWidth(250, 290, 190), 250);
  assert.equal(keptSidebarWidth(290, 290, 190), 290);
});

test("until you set a width, the sidebar's default widens with its text size, and a width you set or brought over is never changed", () => {
  useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarWidth: DEFAULT_SIDEBAR_WIDTH, sidebarTextSize: "default" }, settingsMeta: { chosen: [], inferred: [] } }));
  assert.equal(savedSidebarWidth(S()), DEFAULT_SIDEBAR_WIDTH);
  useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarTextSize: "larger" } }));
  assert.equal(savedSidebarWidth(S()), Math.round((DEFAULT_SIDEBAR_WIDTH * 17) / 13));
  useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarTextSize: "large" } }));
  assert.equal(savedSidebarWidth(S()), Math.round((DEFAULT_SIDEBAR_WIDTH * 15) / 13));
  const id = S().createWindow({ url: "https://text.example/", frame: [80, 80, 520, 620] });
  assert.equal(sidebarWidthIn(S(), id), sidebarWidthLimit(520), "a narrow window still caps the widened default");
  S().updateSettings({ sidebarWidth: 200 });
  assert.equal(sidebarWidthFollowsText(S().settingsMeta), false);
  assert.equal(savedSidebarWidth(S()), 200, "a width you dragged stays exactly yours at any text size");
  resetSidebarWidth();
  assert.equal(S().settings.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
  assert.equal(sidebarWidthFollowsText(S().settingsMeta), true, "Reset hands the width back to the text size");
  assert.equal(savedSidebarWidth(S()), Math.round((DEFAULT_SIDEBAR_WIDTH * 15) / 13));
  useBrowser.setState((s) => ({ settingsMeta: { chosen: [], inferred: ["sidebarWidth"] } }));
  assert.equal(savedSidebarWidth(S()), DEFAULT_SIDEBAR_WIDTH, "a width brought over from another browser counts as yours");
  useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarTextSize: "default" }, settingsMeta: { chosen: [], inferred: [] } }));
});
