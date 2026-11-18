import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { setUrlAnchor, sidebarControlsRow, useUrlAnchors, watchSidebarControlsRow } = await import("./layout.ts");
const windows = (await import("../../lib/platformChrome.windows.ts")).WINDOW_CHROME;
const { SIDEBAR_FIELD } = await import("../../components/sidebar/geometry.ts");

const S = () => useBrowser.getState();
const FIELD_LEFT = 10;

function sidebarField(windowId) {
  return {
    measureInWindow(done) {
      done(FIELD_LEFT, sidebarControlsRow(S(), windowId, windows) + SIDEBAR_FIELD.top, 170, SIDEBAR_FIELD.height);
    },
  };
}

const anchorField = (windowId, view) => view.measureInWindow((left, top, width, height) => setUrlAnchor(windowId, { left, top, width, sidebar: { height } }));

test("the address panel's anchor follows the sidebar field when the window buttons' row appears or goes, though the field's own layout never changes (#1973)", () => {
  S().hydrate({});
  S().updateSettings({ tabLayout: "sidebar", sidebarSide: "left", addressBar: "sidebar", autoHideTabs: false, minimalismMode: false, sidebarWidth: 190 });
  const id = S().createWindow({ url: "https://a.example/" });
  const field = sidebarField(id);
  const rows = [];
  const stop = watchSidebarControlsRow(id, (row) => (rows.push(row), anchorField(id, field)), windows);
  anchorField(id, field);
  const row = windows.trailingWidth ? 33 : 0;
  assert.equal(sidebarControlsRow(S(), id, windows), row);
  assert.equal(useUrlAnchors.getState()[id].top, SIDEBAR_FIELD.top + row, "with the row, the field starts below it");
  S().updateSettings({ minimalismMode: true });
  assert.deepEqual(rows, [0]);
  assert.equal(useUrlAnchors.getState()[id].top, SIDEBAR_FIELD.top, "Minimalism takes the row away and the anchor moves up with the field");
  S().updateSettings({ minimalismMode: false });
  assert.deepEqual(rows, [0, row]);
  assert.equal(useUrlAnchors.getState()[id].top, SIDEBAR_FIELD.top + row, "and back down when the row returns");
  S().updateSettings({ sidebarSide: "right" });
  S().updateSettings({ sidebarSide: "left" });
  assert.deepEqual(rows, [0, row, 0, row], "moving the sidebar to the right and back takes the row away and brings it back");
  S().updateSettings({ compactToolbar: true });
  S().newTab(id, { url: "https://b.example/" });
  assert.deepEqual(rows, [0, row, 0, row], "changes that leave the row as it is don't measure again");
  stop();
  S().updateSettings({ minimalismMode: true });
  assert.deepEqual(rows, [0, row, 0, row], "a stopped watch hears nothing");
});

test("what is open and anchored in the sidebar closes when the window buttons' row appears or goes: the folder panel, the hover card, the icon picker, the bookmark dialog and the command panel on the sidebar field (#1977)", async () => {
  const { closeAnchoredWhenControlsRowChanges } = await import("../sidebar/controlsRowChange.ts");
  const { useFolderPanel } = await import("../sidebar/tileFolderUi.ts");
  const { useSidebarUi } = await import("../sidebar/sidebarUi.ts");
  const { useBookmarkDialog } = await import("../bookmarks/actions.ts");
  S().hydrate({});
  S().updateSettings({ tabLayout: "sidebar", sidebarSide: "left", addressBar: "sidebar", autoHideTabs: false, minimalismMode: false, sidebarWidth: 190 });
  const id = S().createWindow({ url: "https://a.example/" });
  const other = S().createWindow({ url: "https://b.example/" });
  const anchor = { x: 10, y: 200, width: 60, height: 60 };
  const openAll = () => {
    useFolderPanel.setState({ open: { windowId: id, folderId: "f1", anchor } });
    useSidebarUi.setState({ hover: { kind: "tab", id: "t1", windowId: id, anchor }, iconPicker: { kind: "tab", id: "t1", windowId: id, anchor } });
    useBookmarkDialog.setState({ open: { kind: "page", windowId: id, bookmarkId: "b1" } });
    setUrlAnchor(id, { left: 10, top: 79, width: 170, sidebar: { height: 32 } });
    S().openPanel(id);
  };
  const open = () => ({
    folder: !!useFolderPanel.getState().open,
    hover: !!useSidebarUi.getState().hover,
    iconPicker: !!useSidebarUi.getState().iconPicker,
    bookmark: !!useBookmarkDialog.getState().open,
    panel: !!S().windowUi[id]?.panel.open,
  });
  const all = { folder: true, hover: true, iconPicker: true, bookmark: true, panel: true };
  const none = { folder: false, hover: false, iconPicker: false, bookmark: false, panel: false };
  const stop = closeAnchoredWhenControlsRowChanges(id, windows);
  openAll();
  S().updateSettings({ compactToolbar: true });
  assert.deepEqual(open(), all, "a change that leaves the row as it is keeps them open");
  S().updateSettings({ minimalismMode: true });
  assert.deepEqual(open(), none, "Minimalism takes the row away: the folder panel no longer sits 33 points off its moved folder, and nothing else is left at a stale place");
  openAll();
  S().updateSettings({ minimalismMode: false });
  assert.deepEqual(open(), none, "and the same when the row comes back");
  useFolderPanel.setState({ open: { windowId: other, folderId: "f2", anchor } });
  S().updateSettings({ minimalismMode: true });
  assert.ok(useFolderPanel.getState().open, "the watch is for its own window: a folder panel open in another window stays");
  stop();
  useFolderPanel.setState({ open: null });
});
