import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { FADED, iconMarks, isClosedTopApp } = await import("./rowState.ts");

const S = () => useBrowser.getState();

function pins() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.com" });
  const [mail] = S().windows[w].tabIds;
  const docs = S().newTab(w, { url: "https://docs.com", background: true });
  const notes = S().newTab(w, { url: "https://notes.com", background: true });
  S().pinTabs([mail, docs], true);
  S().pinTabs([notes], true, true);
  S().activate(mail);
  S().closeTab(docs);
  S().closeTab(notes);
  return { mail, docs, notes };
}

test("Dia's tiles stay by default: a closed Top App keeps its tile and its icon", () => {
  const { mail, docs } = pins();
  assert.equal(S().settings.closedTopAppTiles, true);
  assert.equal(isClosedTopApp(S(), docs), false);
  assert.equal(isClosedTopApp(S(), mail), false);
  assert.equal(iconMarks(S(), docs) & FADED, 0);
});

test("with the tiles off only a closed Top App drops its tile and fades its icon", () => {
  const { mail, docs, notes } = pins();
  S().updateSettings({ closedTopAppTiles: false });
  assert.equal(isClosedTopApp(S(), docs), true, "a closed tile");
  assert.equal(iconMarks(S(), docs) & FADED, FADED);
  assert.equal(isClosedTopApp(S(), mail), false, "the open, selected tile");
  assert.equal(iconMarks(S(), mail) & FADED, 0);
  assert.equal(isClosedTopApp(S(), notes), false, "a closed pinned row is not a Top App");
  assert.equal(iconMarks(S(), notes) & FADED, 0, "rows still follow Fade icons of unloaded tabs alone");
  S().activate(docs);
  assert.equal(isClosedTopApp(S(), docs), false, "opening it brings the tile back");
});
