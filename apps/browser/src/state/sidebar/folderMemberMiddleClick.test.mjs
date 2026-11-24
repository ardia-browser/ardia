import assert from "node:assert/strict";
import { after, before, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const folders = await import("../pins/tileFolders.ts");
const { activeTabId } = await import("../browser/model.ts");
const { isPageUnloaded } = await import("../pins/pinShare.ts");
const { middleClickFolderMember } = await import("./tileFolderUi.ts");
const { devTabPresses } = await import("../telemetry/tabPresses.ts");
const client = await import("../telemetry/client.ts");

const S = () => useBrowser.getState();

before(() => client.setSharing(true, "settings"));
after(() => client.setSharing(false, "settings"));

function folderOfTwoLoadedTiles() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.example/" });
  const [mail] = S().windows[w].tabIds;
  const docs = S().newTab(w, { url: "https://docs.example/", background: true });
  const other = S().newTab(w, { url: "https://other.example/", background: true });
  S().pinTabs([mail, docs], true);
  const { state, folderId } = folders.newTileFolder(S(), [mail, docs], "Work");
  useBrowser.setState(state);
  S().activate(docs);
  S().activate(mail);
  return { w, mail, docs, other, folderId };
}

test("a middle click on a Top App in a folder closes its page and keeps its tile in the folder, as on an ungrouped tile", () => {
  const { w, mail, docs, folderId } = folderOfTwoLoadedTiles();
  assert.equal(isPageUnloaded(S(), docs), false, "both members start loaded");
  const closes = devTabPresses().tile_folder_middle_closes;
  middleClickFolderMember(w, docs);
  assert.equal(isPageUnloaded(S(), docs), true, "the member's page closed");
  assert.ok(S().tabs[docs], "its tile stays");
  assert.deepEqual(folders.folderMembers(S(), w, folderId), [mail, docs], "and stays in its folder");
  assert.equal(isPageUnloaded(S(), mail), false, "the other member is untouched");
  assert.equal(devTabPresses().tile_folder_middle_closes - closes, 1);
});

test("a middle click on the member in front closes it and moves to another tab, like closing an ungrouped tile in front", () => {
  const { w, mail, folderId } = folderOfTwoLoadedTiles();
  assert.equal(activeTabId(S(), w), mail);
  middleClickFolderMember(w, mail);
  assert.equal(isPageUnloaded(S(), mail), true);
  assert.notEqual(activeTabId(S(), w), mail);
  assert.ok(folders.folderMembers(S(), w, folderId).includes(mail));
});

test("a middle click on a member whose page is already closed keeps the tile and counts nothing", () => {
  const { w, docs, folderId } = folderOfTwoLoadedTiles();
  middleClickFolderMember(w, docs);
  const closes = devTabPresses().tile_folder_middle_closes;
  middleClickFolderMember(w, docs);
  assert.ok(S().tabs[docs]);
  assert.ok(folders.folderMembers(S(), w, folderId).includes(docs));
  assert.equal(devTabPresses().tile_folder_middle_closes, closes);
});
