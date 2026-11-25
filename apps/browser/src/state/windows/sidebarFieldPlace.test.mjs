import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { sidebarSideOf } = await import("../browser/model.ts");
const { setUrlAnchor, sidebarControlsRow, useUrlAnchors, watchSidebarFieldPlace } = await import("./layout.ts");
const { forgetWindowRootSize, setWindowRootSize, windowRootWidth } = await import("./rootSize.ts");
const windows = (await import("../../lib/platformChrome.windows.ts")).WINDOW_CHROME;
const { SIDEBAR_FIELD } = await import("../../components/sidebar/geometry.ts");

const S = () => useBrowser.getState();
const SIDEBAR = 190;
const INSET = 10;
const FIELD = SIDEBAR - 2 * INSET;

function sidebarField(windowId, chrome) {
  return {
    measureInWindow(done) {
      const right = sidebarSideOf(S(), windowId) === "right";
      const x = (right ? windowRootWidth(S(), windowId) - SIDEBAR : 0) + INSET;
      done(x, sidebarControlsRow(S(), windowId, chrome) + SIDEBAR_FIELD.top, FIELD, SIDEBAR_FIELD.height);
    },
  };
}

const anchorField = (windowId, view) => view.measureInWindow((left, top, width, height) => setUrlAnchor(windowId, { left, top, width, sidebar: { height } }));
const anchorLeft = (windowId) => useUrlAnchors.getState()[windowId].left;

function setup(side) {
  S().hydrate({});
  S().updateSettings({ tabLayout: "sidebar", sidebarSide: side, addressBar: "sidebar", autoHideTabs: false, minimalismMode: false, sidebarWidth: SIDEBAR });
  const id = S().createWindow({ url: "https://a.example/" });
  setWindowRootSize(id, 1000, 700);
  return id;
}

for (const [name, chrome] of [
  ["macOS, where the window buttons never take a row at the right", undefined],
  ["Windows, where they do", windows],
]) {
  test(`the address panel's anchor follows the sidebar field when the sidebar changes side or the window is resized, on ${name} (#2021, #1239)`, () => {
    const id = setup("left");
    try {
      const field = sidebarField(id, chrome);
      const stop = watchSidebarFieldPlace(id, () => anchorField(id, field), chrome);
      anchorField(id, field);
      assert.equal(anchorLeft(id), INSET, "with the sidebar on the left the field is at the window's left edge");

      S().updateSettings({ sidebarSide: "right" });
      assert.equal(anchorLeft(id), 1000 - SIDEBAR + INSET, "after the sidebar moves to the right, the anchor is over the field there, not where it was");

      setWindowRootSize(id, 800, 700);
      assert.equal(anchorLeft(id), 800 - SIDEBAR + INSET, "a right sidebar follows the window's right edge when the window is narrowed");
      setWindowRootSize(id, 1200, 700);
      assert.equal(anchorLeft(id), 1200 - SIDEBAR + INSET, "and when it is widened");

      S().updateSettings({ sidebarSide: "left" });
      assert.equal(anchorLeft(id), INSET, "and moving back to the left puts it back");
      stop();
      S().updateSettings({ sidebarSide: "right" });
      assert.equal(anchorLeft(id), INSET, "a stopped watch hears nothing");
    } finally {
      forgetWindowRootSize(id);
    }
  });
}

test("the field's place is measured again only when it can have moved: a side change, the controls row, a right sidebar's window width", () => {
  const id = setup("left");
  const other = S().createWindow({ url: "https://b.example/" });
  try {
    let measured = 0;
    const stop = watchSidebarFieldPlace(id, () => measured++);
    setWindowRootSize(id, 1400, 700);
    S().updateSettings({ compactToolbar: true });
    S().newTab(id, { url: "https://c.example/" });
    assert.equal(measured, 0, "a left sidebar does not move with the window's width, and nothing else here moves the field");
    S().updateSettings({ sidebarSide: "right" });
    assert.equal(measured, 1, "the side moved");
    setWindowRootSize(id, 1500, 700);
    assert.equal(measured, 2, "a right sidebar moves with the width");
    setWindowRootSize(id, 1500, 900);
    assert.equal(measured, 2, "the height is not its concern");
    setWindowRootSize(other, 900, 700);
    assert.equal(measured, 2, "another window's width is not either");
    stop();
  } finally {
    forgetWindowRootSize(id);
    forgetWindowRootSize(other);
  }
});
