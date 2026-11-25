import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { groupStep } = await import("./liveTabs.ts");
const { commonGroup, rootOf } = await import("../groups/groups.ts");
const { isPeekTab } = await import("../peek/peek.ts");
const { TAB_GROUP_COLORS } = await import("@ardia/core");

const S = () => useBrowser.getState();
const TRAVERSALS = new Set(["includes", "indexOf", "some", "every", "find", "findIndex", "filter", "map", "forEach", "slice"]);

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => (x = (x * 1103515245 + 12345) >>> 0) % n;
}

const CHROME_COLORS = new Set(TAB_GROUP_COLORS);
const chromeColor = (color) => (color && CHROME_COLORS.has(color) ? color : "grey");

function referenceGroupStep(s, strip, bound) {
  if (!strip.tabs.some((t) => t.group !== undefined)) return null;
  const known = (t) => !!t?.key && !!s.tabs[t.key] && !isPeekTab(s, t.key);
  const chromeGroupOf = (key) => {
    const g = key ? commonGroup(s.groups, [key]) : undefined;
    return g && rootOf(s.groups, g.id);
  };
  const tabs = strip.tabs.filter((t) => known(t) && !t.pinned && !s.tabs[t.key].pin);
  const looks = new Map((strip.groups ?? []).map((g) => [g.id, g]));
  const tokenOf = (id) => [...bound].find(([token, g]) => g === id && looks.has(token))?.[0];
  const strays = tabs.filter((t) => t.group && t.group !== (chromeGroupOf(t.key) ? tokenOf(chromeGroupOf(t.key).id) : undefined));
  if (strays.length) return { keys: strays.map((t) => t.key), group: null };
  const storeGroups = [...new Set(tabs.map((t) => chromeGroupOf(t.key)).filter((g) => !!g))];
  for (const g of storeGroups) {
    const keys = tabs.filter((t) => chromeGroupOf(t.key)?.id === g.id).map((t) => t.key);
    const token = tokenOf(g.id);
    const look = { title: g.name, color: chromeColor(g.color), collapsed: g.collapsed };
    if (!token) return { keys, group: "new", ...look, makes: g.id };
    const missing = tabs.filter((t) => keys.includes(t.key) && t.group !== token).map((t) => t.key);
    if (missing.length) return { keys: missing, group: token };
    const now = looks.get(token);
    if (now.title !== look.title || now.color !== look.color || now.collapsed !== look.collapsed) return { keys, group: token, ...look };
  }
  return null;
}

function session(r, n) {
  S().hydrate({});
  const w = S().createWindow({ url: "t0.com" });
  for (let i = 1; i < n; i++) S().newTab(w, { url: `t${i}.com`, background: true });
  const ids = () => S().windows[w].tabIds;
  const groups = 1 + r(6);
  for (let g = 0; g < groups; g++) {
    const start = r(n);
    const size = 1 + r(Math.max(1, Math.floor(n / 4)));
    const members = ids().slice(start, start + size).filter((id) => !Object.values(S().groups).some((x) => x.tabIds.includes(id)));
    if (members.length) S().groupTabs(members, { pinned: false, name: `G${g}` });
  }
  const outer = Object.keys(S().groups);
  if (outer.length > 1 && r(2)) {
    const parent = S().groups[outer[0]];
    const childMembers = parent.tabIds.slice(0, Math.max(1, Math.floor(parent.tabIds.length / 2)));
    if (childMembers.length < parent.tabIds.length) S().groupTabs(childMembers, { pinned: false, name: "Inner", parentId: parent.id });
  }
  return w;
}

function stripFor(r, s, w, bound) {
  const tokenOfGroup = new Map([...bound].map(([token, id]) => [id, token]));
  const rootTokenOf = (key) => {
    const g = commonGroup(s.groups, [key]);
    const root = g && rootOf(s.groups, g.id);
    return root ? tokenOfGroup.get(root.id) ?? null : null;
  };
  const tabs = s.windows[w].tabIds.map((key, index) => {
    let group = rootTokenOf(key);
    if (!r(25)) group = r(2) ? null : `cg${r(4)}`;
    return { key, browser: index + 1, index, active: index === 0, pinned: false, group };
  });
  const groups = [...bound].map(([token, id]) => {
    const g = s.groups[id];
    return { id: token, title: r(15) ? g.name : "Other", color: chromeColor(g.color), collapsed: r(15) ? !!g.collapsed : !g.collapsed };
  });
  return { strip: 1, window: 1, appWindow: w, profile: "", activePickedOnClose: false, tabs, groups };
}

test("groupStep answers as the scan over every group did, on random nested groups, bindings and Chrome strips", () => {
  for (let seed = 1; seed <= 250; seed++) {
    const r = rng(seed);
    const w = session(r, 4 + r(60));
    const s = S();
    const bound = new Map();
    Object.keys(s.groups).forEach((id, i) => {
      if (r(6)) bound.set(`cg${i}`, id);
    });
    const strip = stripFor(r, s, w, bound);
    assert.deepEqual(groupStep(s, strip, bound), referenceGroupStep(s, strip, bound), `seed ${seed}`);
  }
});

test("groupStep reads each group's member list once per groups object, however many tabs the strip holds", () => {
  const r = rng(7);
  const w = session(r, 600);
  const s = S();
  let reads = 0;
  const groups = {};
  for (const [id, g] of Object.entries(s.groups)) {
    const tabIds = new Proxy(g.tabIds, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator || TRAVERSALS.has(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    groups[id] = { ...g, tabIds };
  }
  const counted = { ...s, groups };
  const bound = new Map(Object.keys(groups).map((id, i) => [`cg${i}`, id]));
  const strip = stripFor(rng(9), counted, w, bound);
  reads = 0;
  groupStep(counted, strip, bound);
  const first = reads;
  assert.ok(first <= Object.keys(groups).length, `${first} reads of ${Object.keys(groups).length} member lists for ${strip.tabs.length} tabs`);
  groupStep(counted, strip, bound);
  assert.equal(reads, first, "a second step over the same groups reads no member list again");
});

function fixture(n) {
  S().hydrate({});
  const w = S().createWindow({ url: "t0.com" });
  for (let i = 1; i < n; i++) S().newTab(w, { url: `t${i}.com`, background: true });
  return { w, s: S(), ids: S().windows[w].tabIds };
}

const group = (s, w, id, tabIds, extra = {}) => ({ id, name: id, icon: null, color: "blue", windowId: w, profileId: s.windows[w].profileId, collapsed: false, pinned: false, tabIds, createdAt: 0, ...extra });

const stripOf = (s, w, groupOfKey, groups) => ({
  strip: 1, window: 1, appWindow: w, profile: "", activePickedOnClose: false, groups,
  tabs: s.windows[w].tabIds.map((key, index) => ({ key, browser: index + 1, index, active: index === 0, pinned: false, group: groupOfKey(key) })),
});

test("a tab in a nested group is placed by its root group, and a root member Chrome left out is sent back", () => {
  const { w, s, ids } = fixture(6);
  const groups = { outer: group(s, w, "outer", ids.slice(0, 4)), inner: group(s, w, "inner", ids.slice(1, 3), { parentId: "outer" }) };
  const state = { ...s, groups };
  const bound = new Map([["cg-outer", "outer"]]);
  const look = [{ id: "cg-outer", title: "outer", color: "blue", collapsed: false }];
  const strip = stripOf(state, w, (key) => (ids.slice(0, 4).includes(key) && key !== ids[2] ? "cg-outer" : null), look);
  const step = groupStep(state, strip, bound);
  assert.deepEqual(step, { keys: [ids[2]], group: "cg-outer" });
  assert.deepEqual(step, referenceGroupStep(state, strip, bound));
});

test("distinct root groups that share an id gather their members by id, as the scan over every group did", () => {
  const { w, s, ids } = fixture(4);
  const groups = {
    c1: group(s, w, "c1", [ids[1]], { parentId: "r1" }),
    c2: group(s, w, "c2", [ids[2]], { parentId: "r2" }),
    r1: group(s, w, "root", [ids[1]]),
    r2: group(s, w, "root", [ids[2]]),
  };
  const state = { ...s, groups };
  const strip = stripOf(state, w, () => null, []);
  const step = groupStep(state, strip, new Map());
  assert.deepEqual(step.keys, [ids[1], ids[2]]);
  assert.deepEqual(step, referenceGroupStep(state, strip, new Map()));
});
