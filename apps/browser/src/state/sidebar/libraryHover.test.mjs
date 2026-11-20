import assert from "node:assert/strict";
import { test } from "node:test";
const { sidebarUi } = await import("./sidebarUi.ts");
const { addLibraryAnchor, pointLibraryAnchor } = await import("./libraryAnchors.ts");
const { dismissHover, rowEntered, rowLeft, rowShown, rowsCovered, setHoverSpace, setLibraryHeaderPointed, setLibraryListPointed } = await import("./hover.ts");
const { patchLibrary } = await import("../library/library.ts");

const W = "w-library-hover";
const HEIGHT = 800;
setHoverSpace(W, HEIGHT);
patchLibrary(W, { open: true, section: "history" });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (x, y) => ({ nativeEvent: { screenX: x, screenY: HEIGHT - y } });
const view = (y, width = 264) => ({ measureInWindow: (done) => done(96, y, width, 46) });
const row = (id, y) => addLibraryAnchor(W, id, view(y));
const enter = (target, event) => rowEntered(W, target, event, () => rowShown(W, target), () => {});
const leave = (target, event) => rowLeft(W, target, event, true);
const shown = () => sidebarUi().hover?.id ?? null;
const list = {};
const header = {};
let n = 0;
const item = () => ({ kind: "visit", id: `https://${++n}.example/` });

test("once a Library details card shows, the next item's card replaces it at once and stays until the pointer leaves the list", async () => {
  dismissHover();
  const a = item();
  const b = item();
  const drop = [row(a.id, 100), row(b.id, 146)];
  setLibraryListPointed(W, list, true);
  enter(a);
  await settle(900);
  assert.equal(shown(), a.id, "the first card waits for the hover delay");

  leave(a);
  enter(b);
  await settle(0);
  assert.equal(shown(), b.id, "moving to the next item swaps the card without the delay or hiding first");
  assert.equal(sidebarUi().hover?.anchor.y, 146, "the card follows the new item");

  leave(b);
  await settle(300);
  assert.equal(shown(), b.id, "between items, inside the list, the card stays");

  setLibraryListPointed(W, list, false);
  await settle(300);
  assert.equal(shown(), null, "leaving the list hides it");

  enter(a);
  await settle(50);
  assert.equal(shown(), null, "after leaving, the next card waits for the delay again");
  dismissHover();
  drop.forEach((d) => d());
});

test("the card anchors to the item's visible view when the hidden list and cards views both hold it", async () => {
  dismissHover();
  const a = item();
  const drop = [addLibraryAnchor(W, a.id, view(120)), addLibraryAnchor(W, a.id, view(0, 0))];
  setLibraryListPointed(W, list, true);
  enter(a);
  await settle(900);
  assert.equal(shown(), a.id);
  assert.equal(sidebarUi().hover?.anchor.y, 120);
  drop[0]();
  dismissHover();
  enter(a);
  await settle(900);
  assert.equal(shown(), null, "a view that is not laid out never anchors a card");
  leave(a);
  setLibraryListPointed(W, list, false);
  drop[1]();
  dismissHover();
});

test("one list unmounting doesn't forget that the pointer is in another", async () => {
  dismissHover();
  const a = item();
  const b = item();
  const drop = [row(a.id, 100), row(b.id, 146)];
  const other = {};
  setLibraryListPointed(W, list, true);
  setLibraryListPointed(W, other, true);
  setLibraryListPointed(W, other, false);
  enter(a);
  await settle(900);
  leave(a);
  await settle(300);
  assert.equal(shown(), a.id, "the card stays between items");
  setLibraryListPointed(W, list, false);
  await settle(300);
  assert.equal(shown(), null);
  drop.forEach((d) => d());
  dismissHover();
});

test("rows under the search field neither highlight nor show a card, and the row under the pointer comes back when it leaves the field", async () => {
  dismissHover();
  const a = item();
  const drop = row(a.id, 20);
  setLibraryListPointed(W, list, true);
  enter(a);
  await settle(900);
  assert.equal(shown(), a.id);
  setLibraryHeaderPointed(W, header, true);
  assert.equal(shown(), null, "pointing at the search field hides the card at once");
  assert.equal(rowsCovered(W), true, "and the row beneath stops highlighting");
  leave(a);
  enter(a);
  await settle(900);
  assert.equal(shown(), null, "a row entered under the field shows no card");
  setLibraryHeaderPointed(W, header, false);
  assert.equal(rowsCovered(W), false);
  await settle(900);
  assert.equal(shown(), a.id, "below the field again, the row under the pointer gets its card");
  leave(a);
  setLibraryListPointed(W, list, false);
  drop();
  dismissHover();
});

test("a row that scrolls out from under a still pointer takes its card with it", async () => {
  dismissHover();
  const a = item();
  const b = item();
  const drop = [row(a.id, 100), row(b.id, 146)];
  setLibraryListPointed(W, list, true);
  enter(a, at(200, 120));
  await settle(900);
  assert.equal(shown(), a.id);
  leave(a, at(200, 120));
  enter(b, at(200, 120));
  await settle(0);
  assert.equal(shown(), b.id, "the item scrolled under the pointer takes over");
  leave(b, at(200, 160));
  await settle(300);
  assert.equal(shown(), null, "when nothing takes over, the card doesn't point at a row that moved away");
  setLibraryListPointed(W, list, false);
  drop.forEach((d) => d());
  dismissHover();
});

test("the details card closes when the search, section or filter changes under it", async () => {
  dismissHover();
  const a = item();
  const drop = row(a.id, 100);
  setLibraryListPointed(W, list, true);
  enter(a);
  await settle(900);
  assert.equal(shown(), a.id);
  patchLibrary(W, { query: "x" });
  assert.equal(shown(), null);
  patchLibrary(W, { query: "" });
  leave(a);
  setLibraryListPointed(W, list, false);
  drop();
  dismissHover();
});

test("the card anchors to the view the pointer entered when a hidden view of the same item keeps its old frame", async () => {
  dismissHover();
  const a = item();
  const hidden = view(115);
  const card = { measureInWindow: (done) => done(105, 93, 118, 119) };
  const drop = [addLibraryAnchor(W, a.id, hidden), addLibraryAnchor(W, a.id, card)];
  setLibraryListPointed(W, list, true);
  pointLibraryAnchor(W, card);
  enter(a, at(164, 150));
  await settle(900);
  assert.deepEqual(sidebarUi().hover?.anchor, { x: 105, y: 93, width: 118, height: 119 });
  leave(a, at(228, 150));
  await settle(300);
  assert.equal(shown(), a.id, "in the gap between cards, the card stays");
  setLibraryListPointed(W, list, false);
  drop.forEach((d) => d());
  dismissHover();
});
