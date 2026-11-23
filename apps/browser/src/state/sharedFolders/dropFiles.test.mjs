import assert from "node:assert/strict";
import { test } from "node:test";

const dirs = new Map();
const docs = new Map();
const urlOf = (text) => /<key>URL<\/key>\s*<string>([^<]*)/.exec(text ?? "")?.[1];

function levelOf(files, under = "") {
  const entries = new Map();
  let manifest = null;
  for (const [path, text] of [...files].sort()) {
    if (!path.startsWith(under) || path === under) continue;
    const [head, ...rest] = path.slice(under.length).split("/");
    if (head === ".ardia-folder.json") manifest = text;
    else if (!entries.has(head)) entries.set(head, rest.length ? { kind: "dir", file: head, level: levelOf(files, `${under}${head}/`) } : { kind: "link", file: head, text });
  }
  return { entries: [...entries.values()], manifest, manifestPending: false };
}

function applyOp(files, op) {
  const inside = (path) => path.startsWith(`${op.path}/`);
  if (op.op === "write") files.set(op.path, op.text);
  else if (op.op === "mkdir") files.set(`${op.path}/`, "");
  else if (op.op === "move") {
    for (const [path, text] of [...files]) {
      if (path !== op.path && !inside(path)) continue;
      files.delete(path);
      files.set(op.to + path.slice(op.path.length), text);
    }
  } else if (op.op === "delete" && urlOf(files.get(op.path)) === op.expect) files.delete(op.path);
  else if (op.op === "rmdir" && ![...files.keys()].some((path) => inside(path) && path !== `${op.path}/` && path !== `${op.path}/.ardia-folder.json`)) {
    files.delete(`${op.path}/`);
    files.delete(`${op.path}/.ardia-folder.json`);
  }
}

globalThis.acTestNativeModules = {
  ArdiaDocuments: {
    readDocument: (name) => docs.get(name) ?? null,
    writeDocument: (name, text) => void docs.set(name, text),
    saveDocument: async (name, text) => void docs.set(name, text),
    documentSaved: async () => {},
    removeDocument: (name) => void docs.delete(name),
  },
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }),
    read: async (path) => ({ exists: true, root: levelOf(dirs.get(path)) }),
    apply: async (path, ops) => (JSON.parse(ops).forEach((op) => applyOp(dirs.get(path), op)), { conflicts: [] }),
    create: async () => ({}),
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { startPersistence } = await import("../session/persist.ts");
const { resolveDrop } = await import("../drag/drops.ts");
const { beginTabDrag, endTabDrag, setInsertResolver, updateTabDrag } = await import("../drag/tabDrag.ts");
const { guardGroupClose, keepGroupsOpen } = await import("../groups/closeGuard.ts");
const { dropTabIntoSplit, dropTabOnRow, openLinkInSplit } = await import("../splits/actions.ts");
const { chromeChanged } = await import("../tabs/liveTabs.ts");
const { bindFolder, boundFolders, sharedFolderOf, unbindFolder } = await import("./store.ts");
const { confirmRemovingShared, sharedFolderOfGroup } = await import("./removal.ts");
const { syncFolderNow } = await import("./engine.ts");

const S = () => useBrowser.getState();
guardGroupClose(confirmRemovingShared);
keepGroupsOpen((groupId, s = S()) => !!sharedFolderOfGroup(s, groupId));
startPersistence();
const flush = () => new Promise(setImmediate);
const LIST = { zone: "list", beforeId: null };

let runs = 0;
async function shared(names, { flagged = false, sub = [], mirrored = false } = {}) {
  S().hydrate({});
  for (const { profileId, key } of boundFolders()) unbindFolder(profileId, key);
  runs++;
  const w = S().createWindow({ url: `https://home${runs}.example/` });
  const home = S().windows[w].tabIds[0];
  const id = {};
  for (const name of names) {
    id[name] = S().newTab(w, { url: `https://${name}${runs}.example/`, background: true });
    S().updateTab(id[name], { customTitle: name });
  }
  const team = S().groupTabs(Object.values(id), { pinned: true, name: "Team" });
  if (flagged) useBrowser.setState((s) => ({ groups: { ...s.groups, [team]: { ...s.groups[team], autoUngroup: true } } }));
  const { profileId } = S().groups[team];
  const key = pinKeyOf(S().groups[team]);
  const path = `/scratch/${runs}`;
  dirs.set(path, new Map());
  bindFolder(profileId, key, path);
  const sync = async () => {
    for (let round = 0; round < 3; round++) {
      await flush();
      await syncFolderNow(profileId, key);
    }
  };
  await sync();
  const docsGroup = sub.length ? S().groupTabs(sub.map((name) => id[name]), { pinned: true, name: "Docs" }) : undefined;
  if (mirrored) S().createWindow({ profileId });
  await sync();
  const files = () => [...dirs.get(path).keys()].filter((file) => file.endsWith(".webloc")).sort();
  return { w, home, id, team, docsGroup, profileId, sync, files, before: files(), bound: () => !!sharedFolderOf(profileId, key) };
}

const dropTab = (ids, spot) => S().dropTabs(ids, resolveDrop(S(), { kind: "tab" }, spot));

async function afterwards(f, expected, { bound = true } = {}) {
  await f.sync();
  assert.deepEqual(f.files(), expected);
  if (bound) assert.equal(f.bound(), true, "still shared");
}

for (const [how, act, mirrored] of [
  ["onto the other's row", (f) => dropTabOnRow(f.id.beta, f.id.alpha, "right")],
  ["onto the other's page", (f) => dropTabIntoSplit(f.id.beta, f.id.alpha, "right")],
  ["from Open as Split", (f) => S().createSplit([f.id.alpha, f.id.beta])],
  ["onto the other's row with the folder in two windows", (f) => dropTabOnRow(f.id.beta, f.id.alpha, "right"), true],
]) {
  test(`splitting two links of a ⌘-click shared folder ${how} keeps both files`, async () => {
    const f = await shared(["alpha", "beta"], { flagged: true, mirrored });
    act(f);
    await afterwards(f, f.before);
  });
}

for (const [what, names, sub] of [
  ["one link beside a subfolder", ["alpha", "beta"], ["alpha"]],
  ["every link in the subfolder", ["alpha", "beta"], ["alpha", "beta"]],
]) {
  test(`reordering inside a ⌘-click shared folder's subfolder, with ${what}, keeps every file`, async () => {
    const f = await shared(names, { flagged: true, sub });
    dropTab([f.id.alpha], { zone: "group", groupId: f.docsGroup, beforeId: null });
    await afterwards(f, f.before);
  });
}

for (const mirrored of [false, true]) {
  test(`dragging a link out beside a subfolder removes that link's file alone${mirrored ? ", in two windows" : ""}`, async () => {
    const f = await shared(["alpha", "beta"], { flagged: true, sub: ["alpha"], mirrored });
    dropTab([f.id.beta], LIST);
    await afterwards(f, ["Docs/alpha.webloc"]);
  });
}

test("dragging a link out of a subfolder removes that link's file alone", async () => {
  const f = await shared(["alpha", "beta"], { flagged: true, sub: ["alpha"] });
  dropTab([f.id.alpha], LIST);
  await afterwards(f, ["beta.webloc"]);
});

test("dragging the only link out removes its file and keeps the folder shared", async () => {
  const f = await shared(["only"]);
  dropTab([f.id.only], LIST);
  await afterwards(f, []);
});

for (const [action, act] of [
  ["Unpin", (f) => S().placeTabs([f.id.only], { pinned: false, groupId: null })],
  ["Add to Top Apps", (f) => S().pinTabs([f.id.only], true, false)],
  ["Move to Group", (f) => S().placeTabs([f.id.only], { pinned: false, groupId: S().groupTabs([f.home], { pinned: false, name: "List" }) })],
  ["Open as Split", (f) => S().createSplit([f.home, f.id.only])],
  [
    "an extension ungrouping it",
    (f) => {
      const strip = (group) => ({
        strip: 1,
        window: 1,
        profile: "",
        tabs: [
          { key: f.home, browser: 1, index: 0, pinned: false, group: null, active: true },
          { key: f.id.only, browser: 2, index: 1, pinned: false, group, active: false },
        ],
        groups: group ? [{ id: group, title: "Team", color: "grey", collapsed: false }] : [],
      });
      useBrowser.setState(chromeChanged(S(), strip("token"), strip(null), { seen: new Set([f.home, f.id.only]), groups: new Map([["token", f.team]]) }));
    },
  ],
]) {
  test(`${action} on the only link isn't a drag: it never deletes the link's file`, async () => {
    const f = await shared(["only"]);
    act(f);
    await afterwards(f, f.before, { bound: false });
  });
}

test("a window's last tab dropped in another window's tab strip takes its folder along, file and all", async () => {
  const f = await shared(["only"]);
  S().closeTabs([f.home]);
  const away = S().createWindow({ profileId: S().createProfile({ name: "Away" }), url: "https://away.example/" });
  useBrowser.setState((s) => ({
    windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, frame: id === f.w ? [0, 0, 800, 600] : [1000, 0, 800, 600] }])),
    ui: { ...s.ui, focusOrder: Object.keys(s.windows) },
  }));
  setInsertResolver(away, () => null);
  beginTabDrag(f.id.only, [f.id.only]);
  updateTabDrag(1200, 20);
  endTabDrag();
  await afterwards(f, f.before);
  assert.equal(S().tabs[f.id.only].windowId, away);
});

async function tornOff(names) {
  const f = await shared(names);
  const other = S().newTab(f.w, { url: `https://other${runs}.example/`, background: true });
  S().groupTabs([other], { pinned: true, name: "Other" });
  useBrowser.setState((s) => ({ windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, frame: [0, 0, 800, 600] }])) }));
  const tab = f.id[names[0]];
  beginTabDrag(tab, [tab]);
  updateTabDrag(3000, 300);
  endTabDrag();
  await f.sync();
  const away = S().tabs[tab].windowId;
  assert.notEqual(away, f.w);
  assert.deepEqual(f.files(), f.before);
  const groupNamed = (name) => Object.values(S().groups).find((g) => g.windowId === away && g.name === name);
  return { f, tab, team: groupNamed("Team"), other: groupNamed("Other") };
}

for (const names of [["only"], ["alpha", "beta"]]) {
  for (const [where, spotOf] of [
    ["into Pinned above the folder", ({ team }) => ({ zone: "pinnedRows", beforeId: team.tabIds[0] })],
    ["into Top Apps", () => ({ zone: "tiles", beforeId: null })],
    ["into another pinned folder", ({ other }) => ({ zone: "group", groupId: other.id, beforeId: null })],
    ["back into the folder", ({ team }) => ({ zone: "group", groupId: team.id, beforeId: null })],
  ]) {
    test(`a torn-off copy of one of ${names.length} links dragged ${where} changes no file and keeps the folder shared`, async () => {
      const t = await tornOff(names);
      dropTab([t.tab], spotOf(t));
      await afterwards(t.f, t.f.before);
    });
  }

  test(`a torn-off copy of one of ${names.length} links added to Top Apps changes no file and keeps the folder shared`, async () => {
    const t = await tornOff(names);
    S().pinTabs([t.tab], true, false);
    await afterwards(t.f, t.f.before);
  });
}

test("an Empty Folder row that was clicked still can't be dragged out", async () => {
  const f = await shared(["only"]);
  dropTab([f.id.only], LIST);
  await f.sync();
  const row = S().groups[f.team].tabIds[0];
  S().activate(row);
  dropTab([row], LIST);
  await afterwards(f, []);
  assert.deepEqual(S().groups[f.team].tabIds, [row]);
});

test("a pinned tab dropped on a split leaves the split's shared link in its folder", async () => {
  const f = await shared(["only"]);
  const pinnedRow = (name) => {
    const id = S().newTab(f.w, { url: `https://${name}${runs}.example/`, background: true });
    S().pinTabs([id], true, true);
    return id;
  };
  const first = pinnedRow("first");
  const second = pinnedRow("second");
  openLinkInSplit(first, `https://split${runs}.example/`);
  const link = Object.values(S().tabs).find((tab) => tab.url === `https://split${runs}.example/`).id;
  dropTab([link], { zone: "group", groupId: f.team, beforeId: null });
  await f.sync();
  dropTab([f.id.only], LIST);
  await f.sync();
  const files = f.files();
  assert.equal(files.length, 1);
  assert.ok(S().groups[f.team].tabIds.includes(link));
  dropTabOnRow(second, first, "right");
  await afterwards(f, files);
  assert.ok(S().groups[f.team].tabIds.includes(link));
});

for (const names of [["only"], ["alpha", "beta"]]) {
  for (const [how, act] of [
    ["in a list group's header into Pinned", (t) => {
      const list = S().groupTabs([t.tab], { pinned: false, name: "List" });
      S().dropTabs([], resolveDrop(S(), { kind: "group", groupId: list }, { zone: "pinnedRows", beforeId: t.team.tabIds[0] }));
    }],
    ["onto a row of a pinned folder above it", (t) => dropTabOnRow(t.tab, S().groups[t.other.id].tabIds[0], "right")],
    ["onto a page of a pinned folder above it", (t) => dropTabIntoSplit(t.tab, S().groups[t.other.id].tabIds[0], "right")],
    ["into a new pinned group", (t) => S().groupTabs([t.tab], { pinned: true, name: "New" })],
  ]) {
    test(`a torn-off copy of one of ${names.length} links taken ${how} changes no file and keeps the folder shared`, async () => {
      const t = await tornOff(names);
      S().moveGroup(t.other.id, { pinned: true, parentId: null, beforeId: S().groups[t.team.id].tabIds[0] });
      await t.f.sync();
      act(t);
      await afterwards(t.f, t.f.before);
    });
  }
}

for (const [where, firstPinned, drop] of [
  ["on a pinned row of its split", true, (f, first, tab) => dropTabOnRow(tab, first, "right")],
  ["on the page of a pinned pane of its split", true, (f, first, tab) => dropTabIntoSplit(tab, first, "right")],
  ["left of a listed pane of its split", false, (f, first, tab) => dropTabOnRow(tab, first, "left")],
  ["right of a listed pane of its split", false, (f, first, tab) => dropTabOnRow(tab, first, "right")],
]) {
  test(`a listed tab dropped ${where} changes no file of the shared link beside it`, async () => {
    const f = await shared(["only"]);
    const first = S().newTab(f.w, { url: `https://first${runs}.example/`, background: true });
    S().pinTabs([first], true, true);
    openLinkInSplit(first, `https://split${runs}.example/`);
    const link = Object.values(S().tabs).find((tab) => tab.url === `https://split${runs}.example/`).id;
    dropTab([link], { zone: "group", groupId: f.team, beforeId: null });
    if (!firstPinned) S().pinTabs([first], false);
    await f.sync();
    const files = f.files();
    assert.equal(files.length, 2);
    const tab = S().newTab(f.w, { url: `https://listed${runs}.example/`, background: true });
    drop(f, first, tab);
    await afterwards(f, files);
    assert.ok(S().groups[f.team].tabIds.includes(link));
  });
}

test("a link opened in a split from a shared folder's link still joins the folder", async () => {
  const f = await shared(["only"]);
  openLinkInSplit(f.id.only, `https://split${runs}.example/`);
  await f.sync();
  assert.equal(f.files().length, 2);
});

for (const blank of ["about:blank", ""]) {
  test(`a real link showing ${blank || "an empty address"} can still be dragged out`, async () => {
    const f = await shared(["only"]);
    const home = S().tabs[f.id.only].url;
    S().updateTab(f.id.only, { pinnedUrl: home, url: blank });
    await f.sync();
    dropTab([f.id.only], LIST);
    await f.sync();
    assert.equal(S().groups[f.team].tabIds.includes(f.id.only), false);
    assert.equal(f.bound(), true, "still shared");
  });
}

test("a tab dropped on a split leaves the other pane in its subfolder", async () => {
  const f = await shared(["alpha", "untouched", "stay"], { sub: ["untouched"] });
  const id = `split-subfolder-${runs}`;
  const slots = [f.id.alpha, f.id.untouched].map((tabId) => ({ size: 0.5, tabId }));
  useBrowser.setState((s) => ({ splits: { ...s.splits, [id]: { id, windowId: f.w, orientation: "horizontal", slots } } }));
  await f.sync();
  const dropped = S().newTab(f.w, { url: `https://dropped${runs}.example/`, background: true });
  S().updateTab(dropped, { customTitle: "dropped" });
  dropTabOnRow(dropped, f.id.alpha, "left");
  await afterwards(f, ["Docs/untouched.webloc", "alpha.webloc", "dropped.webloc", "stay.webloc"]);
});

for (const names of [["only"], ["alpha", "beta"]]) {
  test(`a torn-off copy of one of ${names.length} links dragged back to a profile whose pins are parked changes no file`, async () => {
    const { f, tab } = await tornOff(names);
    const work = S().createProfile({ name: "Work" });
    const there = S().createWindow({ profileId: work, url: `https://work${runs}.example/` });
    const away = S().tabs[tab].windowId;
    S().dropTabsInProfile([tab], work, { type: "none" });
    S().moveTabsToWindow([tab], there);
    S().pinTabs([tab], true, false);
    for (const w of [f.w, away]) if (S().windows[w]) S().closeWindow(w);
    await f.sync();
    assert.ok(S().parkedPins[f.profileId], "setup: the folder's pins are parked");
    assert.deepEqual(f.files(), f.before);
    S().dropTabsInProfile([tab], f.profileId, { type: "none" });
    await afterwards(f, f.before);
  });

  for (const [how, act] of [
    ["the copy onto another tab's row", (copy, other) => dropTabOnRow(copy, other, "right")],
    ["another tab onto the copy's page", (copy, other) => dropTabIntoSplit(other, copy, "right")],
  ]) {
    test(`with tabs shared across windows, dragging ${how} keeps the files of ${names.length} links`, async () => {
      const f = await shared(names);
      useBrowser.setState((s) => ({ settings: { ...s.settings, shareTabsAcrossWindows: true } }));
      S().activate(f.id[names[0]]);
      const second = S().createWindow({ profileId: f.profileId });
      await f.sync();
      useBrowser.setState((s) => ({ windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, frame: [0, 0, 800, 600] }])) }));
      const inFolder = (id) => Object.values(S().groups).some((g) => g.pinned && g.tabIds.includes(id));
      const copy = S().windows[second].tabIds.find((id) => inFolder(id) && pinKeyOf(S().tabs[id]) === f.id[names[0]]);
      S().setFocusedWindow(second);
      beginTabDrag(copy, [copy]);
      updateTabDrag(3000, 300);
      endTabDrag();
      await f.sync();
      assert.deepEqual(f.files(), f.before);
      const away = S().tabs[copy].windowId;
      act(copy, S().windows[away].tabIds.find((id) => id !== copy && !S().tabs[id].pin && !inFolder(id)));
      await afterwards(f, f.before);
      useBrowser.setState((s) => ({ settings: { ...s.settings, shareTabsAcrossWindows: false } }));
    });
  }
}
