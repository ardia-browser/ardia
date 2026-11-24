import assert from "node:assert/strict";
import test from "node:test";
import { applyOps, bookmarkOps } from "./flatBookmarks.ts";
import { rootIdsFor } from "./bookmarks.ts";

const roots = rootIdsFor("");
const folder = (parent, title) => ({ kind: "folder", parent, title, addedAt: 0 });
const url = (parent, title = "link") => ({ kind: "url", parent, title, url: "https://example.invalid", addedAt: 0 });
const copy = (flat) => ({ nodes: new Map(flat.nodes), children: new Map([...flat.children].map(([id, children]) => [id, [...children]])) });
const sorted = (map) => [...map].sort(([a], [b]) => a.localeCompare(b));
const equalFlat = (a, b) => {
  assert.deepEqual(sorted(a.nodes), sorted(b.nodes));
  assert.deepEqual(sorted(a.children), sorted(b.children));
};
const reaches = (from, to) => {
  const ops = bookmarkOps(from, to, "");
  equalFlat(applyOps(from, ops, ""), to);
  return ops;
};
const twoFolders = (source, target) => ({
  nodes: new Map([
    [roots.bar, folder(null, "bar")],
    [roots.other, folder(null, "other")],
    ["source", folder(roots.other, "source")],
    ["target", folder(roots.other, "target")],
    ...source.map((id) => [id, url("source", id)]),
    ...target.map((id) => [id, url("target", id)]),
  ]),
  children: new Map([[roots.bar, []], [roots.other, ["source", "target"]], ["source", source], ["target", target]]),
});
const place = (flat, parent, ids) => {
  flat.children.set(parent, ids);
  for (const id of ids) flat.nodes.set(id, { ...flat.nodes.get(id), parent });
};
const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

test("moving 100 bookmarks out of a 32,000-bookmark folder sends 100 moves, in well under a second of CPU", () => {
  const ids = names("link", 32000);
  const from = twoFolders(ids, []);
  const to = copy(from);
  place(to, "source", ids.slice(100));
  place(to, "target", ids.slice(0, 100));
  const started = process.cpuUsage();
  const ops = bookmarkOps(from, to, "");
  const { user, system } = process.cpuUsage(started);
  assert.deepEqual(ops.map((op) => `${op.op} ${op.id} ${op.index}`), ids.slice(0, 100).map((id, i) => `move ${id} ${i}`));
  equalFlat(applyOps(from, ops, ""), to);
  assert.ok((user + system) / 1000 < 1000, `${((user + system) / 1000).toFixed(0)} ms of CPU`);
});

test("bookmarks dropped ahead of a folder's own leave the ones already there alone", () => {
  const moved = names("moved", 16000);
  const existing = names("existing", 16000);
  const from = twoFolders(moved, existing);
  const to = copy(from);
  place(to, "source", moved.slice(100));
  place(to, "target", [...existing.slice(0, 7), ...moved.slice(0, 100), ...existing.slice(7)]);
  const ops = reaches(from, to);
  assert.equal(ops.length, 100);
  assert.deepEqual([ops[0].index, ops[99].index], [7, 106]);
});

test("a whole 8,000-bookmark folder moves into another, each bookmark once", () => {
  const ids = names("link", 8000);
  const from = twoFolders(ids, ["first", "last"]);
  const to = copy(from);
  place(to, "source", []);
  place(to, "target", ["first", ...ids, "last"]);
  const ops = reaches(from, to);
  assert.equal(ops.length, 8000);
  assert.ok(ops.every((op, i) => op.op === "move" && op.index === i + 1));
});

test("a reorder moves the fewest bookmarks", () => {
  const ids = names("link", 2000);
  const from = twoFolders(ids, []);
  const down = copy(from);
  place(down, "source", [...ids.slice(1), ids[0]]);
  assert.deepEqual(reaches(from, down), [{ op: "move", id: ids[0], parent: "source", index: 1999 }]);
  const up = copy(from);
  place(up, "source", [ids[1999], ...ids.slice(0, 1999)]);
  assert.deepEqual(reaches(from, up), [{ op: "move", id: ids[1999], parent: "source", index: 0 }]);
  const block = copy(from);
  place(block, "source", [...ids.slice(100, 150), ...ids.slice(0, 100), ...ids.slice(150)]);
  assert.equal(reaches(from, block).length, 50);
  const mixed = copy(from);
  place(mixed, "source", ["link-2", "link-0", "link-3", "link-1", ...ids.slice(4)]);
  assert.equal(reaches(from, mixed).length, 2);
});

test("a move lands where it should while deleted and departing siblings are still in the folder", () => {
  const from = twoFolders(["a", "gone", "b", "leaving", "c"], ["x"]);
  const to = copy(from);
  to.nodes.delete("gone");
  place(to, "source", ["x", "a", "c", "b"]);
  place(to, "target", ["leaving"]);
  reaches(from, to);
});

test("a bookmark kept from a deleted folder moves out before the folder goes", () => {
  const from = twoFolders(["kept"], []);
  const to = copy(from);
  to.nodes.delete("source");
  to.children.delete("source");
  to.children.set(roots.other, ["target"]);
  place(to, "target", ["kept"]);
  assert.deepEqual(reaches(from, to).map((op) => `${op.op} ${op.id}`), ["move kept", "remove source"]);
});

test("a folder and the folder it was in can trade places", () => {
  const from = {
    nodes: new Map([[roots.bar, folder(null, "bar")], [roots.other, folder(null, "other")], ["outer", folder(roots.bar, "outer")], ["inner", folder("outer", "inner")], ["leaf", url("inner")]]),
    children: new Map([[roots.bar, ["outer"]], [roots.other, []], ["outer", ["inner"]], ["inner", ["leaf"]]]),
  };
  const to = copy(from);
  place(to, roots.bar, ["inner"]);
  place(to, "inner", ["outer", "leaf"]);
  place(to, "outer", []);
  to.nodes.set("inner", { ...to.nodes.get("inner"), parent: roots.bar });
  reaches(from, to);
});

test("a moved bookmark's new title and URL go with it", () => {
  const from = twoFolders(["moving"], []);
  const to = copy(from);
  place(to, "source", []);
  place(to, "target", ["moving"]);
  to.nodes.set("moving", { ...to.nodes.get("moving"), title: "after", url: "https://after.example/" });
  assert.deepEqual(reaches(from, to).map((op) => op.op), ["move", "update"]);
});

test("any edit of a random tree is reached, and never with more moves than bookmarks that changed place", () => {
  let seed = 20261114;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const below = (n) => Math.floor(random() * n);
  for (let round = 0; round < 400; round++) {
    const from = { nodes: new Map([[roots.bar, folder(null, "bar")], [roots.other, folder(null, "other")]]), children: new Map([[roots.bar, []], [roots.other, []]]) };
    const folders = [roots.bar, roots.other];
    const size = 1 + below(40);
    for (let i = 0; i < size; i++) {
      const parent = folders[below(folders.length)];
      const id = `n${i}`;
      const isFolder = random() < 0.3;
      from.nodes.set(id, isFolder ? folder(parent, id) : url(parent, id));
      from.children.get(parent).push(id);
      if (isFolder) {
        from.children.set(id, []);
        folders.push(id);
      }
    }
    const to = copy(from);
    const inside = (id, of) => {
      for (let at = of; at; at = to.nodes.get(at)?.parent) if (at === id) return true;
      return false;
    };
    const detach = (id) => {
      const list = to.children.get(to.nodes.get(id).parent);
      list.splice(list.indexOf(id), 1);
    };
    const edits = below(12);
    let added = 0;
    for (let e = 0; e < edits; e++) {
      const live = [...to.nodes.keys()].filter((id) => to.nodes.get(id).parent !== null);
      const liveFolders = [...to.nodes.keys()].filter((id) => to.nodes.get(id).kind === "folder");
      const kind = below(5);
      const parent = liveFolders[below(liveFolders.length)];
      if (kind === 0 || !live.length) {
        const id = `new${round}-${added++}`;
        const isFolder = random() < 0.3;
        to.nodes.set(id, isFolder ? folder(parent, id) : url(parent, id));
        if (isFolder) to.children.set(id, []);
        const list = to.children.get(parent);
        list.splice(below(list.length + 1), 0, id);
        continue;
      }
      const id = live[below(live.length)];
      if (kind === 1) {
        const lift = to.children.get(id) ?? [];
        const keep = random() < 0.5 ? lift.splice(0, lift.length) : [];
        const drop = (at) => {
          for (const child of to.children.get(at) ?? []) drop(child);
          to.nodes.delete(at);
          to.children.delete(at);
        };
        const home = to.nodes.get(id).parent;
        detach(id);
        drop(id);
        for (const child of keep) {
          to.nodes.set(child, { ...to.nodes.get(child), parent: home });
          to.children.get(home).push(child);
        }
      } else if (kind === 2) {
        to.nodes.set(id, { ...to.nodes.get(id), title: `renamed ${e}` });
      } else if (!inside(id, parent)) {
        detach(id);
        to.nodes.set(id, { ...to.nodes.get(id), parent });
        const list = to.children.get(parent);
        list.splice(below(list.length + 1), 0, id);
      }
    }
    const ops = reaches(from, to);
    const displaced = [...to.nodes.keys()].filter((id) => from.nodes.has(id) && to.nodes.get(id).parent !== null).length;
    assert.ok(ops.filter((op) => op.op === "move").length <= displaced);
    assert.equal(ops.filter((op) => op.op === "add").length, [...to.nodes.keys()].filter((id) => !from.nodes.has(id)).length);
  }
});
