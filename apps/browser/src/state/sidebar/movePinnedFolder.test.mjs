import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { inPinnedContainer } = await import("../browser/model.ts");
const { forgetListSpots, movePinnedTitle, togglePinnedRows } = await import("./movePinned.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].url).hostname.split(".")[0];
const list = (w) => S().windows[w].tabIds.filter((id) => !inPinnedContainer(S(), id)).map(host);
const pinned = (w) => S().windows[w].tabIds.filter((id) => inPinnedContainer(S(), id)).map(host);

function windowWith(...hosts) {
  S().hydrate({});
  forgetListSpots();
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/`, background: true }));
  S().activate(ids[0]);
  return { w, ids };
}

const press = (w, active, selection = []) => {
  S().activate(active);
  S().setSelection(w, selection);
  togglePinnedRows(w);
};

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("Move to Pinned on a whole selected folder pins the folder and brings it back to its place", () => {
  const { w, ids: [, b, c] } = windowWith("a", "b", "c", "d");
  const folder = S().groupTabs([b, c], { name: "Reading", pinned: false });
  press(w, b, [b, c]);
  assert.equal(S().groups[folder]?.pinned, true, "the folder itself is pinned");
  assert.deepEqual(S().groups[folder].tabIds, [b, c]);
  assert.equal(S().groups[folder].name, "Reading");
  assert.deepEqual(pinned(w), ["b", "c"]);
  assert.deepEqual(list(w), ["a", "d"]);
  assert.equal(S().tabs[b].pin, null, "its tabs stay in the folder, not loose pinned rows");
  S().setSelection(w, []);
  assert.equal(movePinnedTitle(S(), w), "Move out of Pinned", "the shortcut takes the folder it pinned back out");

  press(w, c);
  assert.equal(S().groups[folder]?.pinned, false);
  assert.deepEqual(S().groups[folder].tabIds, [b, c]);
  assert.deepEqual(list(w), ["a", "b", "c", "d"]);
  assert.deepEqual(pinned(w), []);
});

test("a folder of one tab moves whole when its tab is the active one", () => {
  const { w, ids: [, b] } = windowWith("a", "b", "c");
  const folder = S().groupTabs([b], { name: "Solo", pinned: false });
  press(w, b);
  assert.equal(S().groups[folder]?.pinned, true);
  assert.deepEqual(list(w), ["a", "c"]);
  press(w, b);
  assert.equal(S().groups[folder]?.pinned, false);
  assert.deepEqual(list(w), ["a", "b", "c"]);
});

test("a folder and a loose tab selected together: the folder moves whole and the tab becomes a pinned row", () => {
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c", "d");
  const folder = S().groupTabs([b, c], { pinned: false });
  press(w, b, [a, b, c]);
  assert.equal(S().groups[folder]?.pinned, true);
  assert.deepEqual(S().groups[folder].tabIds, [b, c]);
  assert.equal(S().tabs[a].pin?.as, "row");
  assert.deepEqual(list(w), ["d"]);
});

test("a nested folder goes to Pinned on its own and comes back inside its parent", () => {
  const { w, ids: [, b, c, d] } = windowWith("a", "b", "c", "d", "e");
  const outer = S().groupTabs([b, c, d], { name: "Outer", pinned: false });
  S().activate(c);
  const inner = S().groupTabs([c, d], { name: "Inner", pinned: false });
  S().moveGroup(inner, { pinned: false, parentId: outer });
  assert.equal(S().groups[inner].parentId, outer);
  press(w, c, [c, d]);
  assert.equal(S().groups[inner]?.pinned, true);
  assert.deepEqual(S().groups[outer].tabIds, [b]);
  press(w, c, [c, d]);
  assert.equal(S().groups[inner]?.pinned, false);
  assert.equal(S().groups[inner].parentId, outer);
  assert.deepEqual(S().groups[outer].tabIds, [b, c, d]);
  assert.deepEqual(list(w), ["a", "b", "c", "d", "e"]);
});

test("one tab of a bigger folder still goes alone, and a whole pinned folder leaves Pinned as a folder", () => {
  const { w, ids: [, b, c] } = windowWith("a", "b", "c", "d");
  const folder = S().groupTabs([b, c], { pinned: false });
  press(w, c);
  assert.equal(S().groups[folder]?.pinned, false);
  assert.deepEqual(S().groups[folder].tabIds, [b]);
  assert.equal(S().tabs[c].pin?.as, "row");

  const { w: w2, ids: [, y, z] } = windowWith("x", "y", "z");
  const menuPinned = S().groupTabs([y, z], { name: "Docs", pinned: false });
  S().moveGroup(menuPinned, { pinned: true });
  S().activate(y);
  S().setSelection(w2, []);
  assert.equal(movePinnedTitle(S(), w2).startsWith("Move to"), true, "one tab of a folder pinned from its menu isn't the folder");
  press(w2, y, [y, z]);
  assert.equal(S().groups[menuPinned]?.pinned, false, "the whole selected folder leaves Pinned");
  assert.deepEqual(S().groups[menuPinned].tabIds, [y, z]);
  assert.equal(S().groups[menuPinned].name, "Docs");
  assert.deepEqual(pinned(w2), []);
});

test("each folder moved by the shortcut is counted, only while sharing is on", async () => {
  for (const sharing of [true, false]) {
    client.setSharing(sharing, "settings");
    const before = (await usageCounts()).length;
    const { w, ids: [, b, c] } = windowWith("a", "b", "c");
    S().groupTabs([b, c], { pinned: false });
    press(w, b, [b, c]);
    press(w, b, [b, c]);
    usage.sessionEnding();
    const sent = (await usageCounts()).slice(before);
    assert.deepEqual(
      sent.filter((e) => e.pin_key_folders_pinned || e.pin_key_folders_unpinned).map((e) => [e.pin_key_folders_pinned, e.pin_key_folders_unpinned]),
      sharing ? [[1, 1]] : [],
    );
  }
});

test("a pinned folder brought back keeps a one-tab folder inside it", () => {
  const { w, ids: [, b, c] } = windowWith("a", "b", "c", "d");
  const outer = S().groupTabs([b, c], { name: "Outer", pinned: false });
  S().activate(c);
  const inner = S().groupTabs([c], { name: "Inner", pinned: false });
  S().moveGroup(inner, { pinned: false, parentId: outer });
  press(w, b, [b, c]);
  assert.equal(S().groups[outer]?.pinned, true);
  press(w, c);
  assert.equal(S().groups[outer]?.pinned, false);
  assert.equal(S().groups[inner]?.parentId, outer, "the inner folder stays inside the outer one");
  assert.deepEqual(S().groups[outer].tabIds, [b, c]);
  assert.deepEqual(list(w), ["a", "b", "c", "d"]);
});

test("a folder and a loose tab pinned together come back together, from either one", () => {
  for (const activeBack of ["folder", "row"]) {
    const { w, ids: [a, b, c] } = windowWith("a", "b", "c", "d");
    const folder = S().groupTabs([b, c], { pinned: false });
    press(w, b, [a, b, c]);
    assert.equal(S().tabs[a].pin?.as, "row");
    press(w, activeBack === "folder" ? b : a, [a, b, c]);
    assert.equal(S().tabs[a].pin, null, `the row comes back (${activeBack} active)`);
    assert.equal(S().groups[folder]?.pinned, false, `the folder comes back (${activeBack} active)`);
    assert.deepEqual(list(w), ["a", "b", "c", "d"]);
  }
});

test("Move out of Pinned on a folder's copy in another window puts the first window's folder back", () => {
  const { w, ids: [, b, c] } = windowWith("a", "b", "c", "d");
  const folder = S().groupTabs([b, c], { name: "Reading", pinned: false });
  press(w, b, [b, c]);
  const w2 = S().createWindow({ url: "https://other.com/" });
  const copy = Object.values(S().groups).find((g) => g.windowId === w2 && g.pinned && (g.pinKey ?? g.id) === folder);
  assert.ok(copy, "the folder is mirrored into the second window");
  assert.notEqual(copy.id, folder);
  press(w2, copy.tabIds[0]);
  assert.equal(S().groups[folder]?.pinned, false, "the first window's folder leaves Pinned whole");
  assert.deepEqual(S().groups[folder].tabIds.map(host), ["b", "c"]);
  assert.deepEqual(list(w), ["a", "b", "c", "d"]);
  assert.deepEqual(pinned(w2), [], "the copy leaves the second window's Pinned");
});

test("folders pinned one after the other and brought back together keep their order", () => {
  for (const firstPinned of ["c", "b"]) {
    const { w, ids: [, b, c] } = windowWith("a", "b", "c", "d");
    const fb = S().groupTabs([b], { pinned: false });
    const fc = S().groupTabs([c], { pinned: false });
    for (const id of firstPinned === "c" ? [c, b] : [b, c]) press(w, id);
    assert.equal(S().groups[fb]?.pinned && S().groups[fc]?.pinned, true);
    press(w, b, [b, c]);
    assert.deepEqual(list(w), ["a", "b", "c", "d"], `pinned ${firstPinned} first`);
  }
});
