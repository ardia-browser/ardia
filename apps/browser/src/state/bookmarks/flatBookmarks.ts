import { rootIdsFor } from "./bookmarks";
import type { BookmarkOp, EngineBookmark } from "./engineSync";
import type { Bookmarks } from "../browser/types";

type FlatNode = { kind: "url" | "folder"; parent: string | null; title: string; url?: string; addedAt: number; key?: string };
export type Flat = { nodes: Map<string, FlatNode>; children: Map<string, string[]> };

const emptyFlat = (): Flat => ({ nodes: new Map(), children: new Map() });
const cloneFlat = (f: Flat): Flat => ({ nodes: new Map(f.nodes), children: new Map([...f.children].map(([id, c]) => [id, [...c]])) });

export function flatFromStore(b: Bookmarks, engine: string): Flat {
  const roots = rootIdsFor(engine);
  const flat = emptyFlat();
  const walk = (id: string, parent: string | null) => {
    const node = b.nodes[id];
    if (!node || flat.nodes.has(id)) return;
    flat.nodes.set(id, {
      kind: node.kind,
      parent,
      title: node.title,
      ...(node.kind === "url" ? { url: node.url } : {}),
      addedAt: node.addedAt,
      ...(node.syncKey ? { key: node.syncKey } : {}),
    });
    if (node.kind !== "folder") return;
    const kids: string[] = [];
    for (const c of node.children) {
      if (!b.nodes[c] || flat.nodes.has(c)) continue;
      walk(c, id);
      kids.push(c);
    }
    flat.children.set(id, kids);
  };
  walk(roots.bar, null);
  walk(roots.other, null);
  return flat;
}

export function flatFromEngine(tree: { bar: EngineBookmark; other: EngineBookmark }, engine: string): Flat {
  const roots = rootIdsFor(engine);
  const flat = emptyFlat();
  const walk = (node: EngineBookmark, id: string, parent: string | null) => {
    flat.nodes.set(id, {
      kind: node.k === "u" ? "url" : "folder",
      parent,
      title: node.t,
      ...(node.k === "u" ? { url: node.u ?? "" } : {}),
      addedAt: node.a,
      ...(node.key ? { key: node.key } : {}),
    });
    if (node.k === "f") {
      flat.children.set(id, (node.c ?? []).map((c) => c.id));
      for (const c of node.c ?? []) walk(c, c.id, id);
    }
  };
  walk(tree.bar, roots.bar, null);
  walk(tree.other, roots.other, null);
  return flat;
}

const opParent = (engine: string, id: string) => {
  const roots = rootIdsFor(engine);
  return id === roots.bar ? "bar" : id === roots.other ? "other" : id;
};
const flatParent = (engine: string, id: string) => {
  const roots = rootIdsFor(engine);
  return id === "bar" ? roots.bar : id === "other" ? roots.other : id;
};

function longestRising(values: Int32Array): Uint8Array {
  const kept = new Uint8Array(values.length);
  const before = new Int32Array(values.length).fill(-1);
  const tails: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (value < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    if (low) before[i] = tails[low - 1]!;
    tails[low] = i;
  }
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = before[i]!) kept[i] = 1;
  return kept;
}

class SlotCounts {
  readonly #sums: Int32Array;
  constructor(filled: Uint8Array) {
    const sums = (this.#sums = new Int32Array(filled.length + 1));
    for (let i = 1; i <= filled.length; i++) {
      sums[i]! += filled[i - 1]!;
      const up = i + (i & -i);
      if (up <= filled.length) sums[up]! += sums[i]!;
    }
  }
  add(slot: number, by: number) {
    for (let i = slot + 1; i < this.#sums.length; i += i & -i) this.#sums[i]! += by;
  }
  before(slot: number) {
    let count = 0;
    for (let i = slot; i > 0; i -= i & -i) count += this.#sums[i]!;
    return count;
  }
}

function childPlaces(have: readonly string[], want: readonly string[]): Map<string, () => number> {
  const places = new Map<string, () => number>();
  let same = have.length === want.length;
  for (let i = 0; same && i < want.length; i++) same = have[i] === want[i];
  if (same) return places;
  const haveAt = new Map<string, number>();
  have.forEach((id, i) => haveAt.set(id, i));
  const kept = longestRising(Int32Array.from(want, (id) => haveAt.get(id) ?? -1));
  const keptAt = new Map<string, number>();
  const newSlot = new Int32Array(want.length);
  const oldSlot = new Int32Array(have.length);
  let slots = 0;
  const run = (from: number) => {
    for (let i = from; i < want.length && !kept[i]; i++) newSlot[i] = slots++;
  };
  want.forEach((id, i) => kept[i] && keptAt.set(id, i));
  run(0);
  have.forEach((id, i) => {
    oldSlot[i] = slots++;
    const at = keptAt.get(id);
    if (at !== undefined) run(at + 1);
  });
  const filled = new Uint8Array(slots);
  for (const slot of oldSlot) filled[slot] = 1;
  const counts = new SlotCounts(filled);
  want.forEach((id, i) => {
    if (kept[i]) return;
    places.set(id, () => {
      const was = haveAt.get(id);
      if (was !== undefined) counts.add(oldSlot[was]!, -1);
      const index = counts.before(newSlot[i]!);
      counts.add(newSlot[i]!, 1);
      return index;
    });
  });
  return places;
}

export function bookmarkOps(from: Flat, to: Flat, engine: string): BookmarkOp[] {
  const roots = rootIdsFor(engine);
  const parentOf = new Map<string, string | null>();
  for (const [id, n] of from.nodes) parentOf.set(id, n.parent);
  const ops: BookmarkOp[] = [];
  const queue = [roots.bar, roots.other];
  for (let next = 0; next < queue.length; next++) {
    const folder = queue[next]!;
    const want = to.children.get(folder) ?? [];
    const have = (from.children.get(folder) ?? []).filter((id) => parentOf.get(id) === folder);
    const places = childPlaces(have, want);
    for (const id of want) {
      const node = to.nodes.get(id)!;
      const was = from.nodes.get(id);
      const place = places.get(id);
      if (!parentOf.has(id)) {
        ops.push({
          op: "add",
          id,
          k: node.kind === "url" ? "u" : "f",
          t: node.title,
          ...(node.url !== undefined ? { u: node.url } : {}),
          a: node.addedAt,
          ...(node.key ? { key: node.key } : {}),
          parent: opParent(engine, folder),
          index: place!(),
        });
        parentOf.set(id, folder);
      } else {
        if (place) {
          ops.push({ op: "move", id, parent: opParent(engine, folder), index: place() });
          parentOf.set(id, folder);
        }
        if (was && (was.title !== node.title || (node.url !== undefined && was.url !== node.url))) {
          ops.push({ op: "update", id, t: node.title, ...(node.url !== undefined ? { u: node.url } : {}) });
        }
      }
      if (node.kind === "folder") queue.push(id);
    }
  }
  for (const [id, n] of from.nodes) {
    if (to.nodes.has(id) || n.parent === null) continue;
    let under = false;
    for (let at = parentOf.get(id); at && !under; at = parentOf.get(at)) under = !to.nodes.has(at);
    if (!under) ops.push({ op: "remove", id });
  }
  return ops;
}

const keepsUrl = (url: string) => /^[a-z][a-z0-9+.-]*:./i.test(url);

export function applyOps(tree: Flat, ops: BookmarkOp[], engine: string): Flat {
  const flat = cloneFlat(tree);
  const detach = (id: string) => {
    const parent = flat.nodes.get(id)?.parent;
    const list = parent ? flat.children.get(parent) : undefined;
    if (list) list.splice(list.indexOf(id), 1);
  };
  const attach = (id: string, parent: string, index: number | undefined) => {
    const list = flat.children.get(parent)!;
    list.splice(Math.max(0, Math.min(index ?? list.length, list.length)), 0, id);
    flat.nodes.set(id, { ...flat.nodes.get(id)!, parent });
  };
  const inside = (id: string, of: string) => {
    for (let at: string | null | undefined = of; at; at = flat.nodes.get(at)?.parent) if (at === id) return true;
    return false;
  };
  for (const op of ops) {
    const node = flat.nodes.get(op.id);
    if (op.op === "remove") {
      if (!node || node.parent === null) break;
      detach(op.id);
      const drop = (id: string) => {
        for (const c of flat.children.get(id) ?? []) drop(c);
        flat.nodes.delete(id);
        flat.children.delete(id);
      };
      drop(op.id);
      continue;
    }
    if (op.op === "update") {
      if (!node || node.parent === null) break;
      flat.nodes.set(op.id, { ...node, ...(op.t !== undefined ? { title: op.t } : {}), ...(op.u && node.kind === "url" && keepsUrl(op.u) ? { url: op.u } : {}) });
      continue;
    }
    const parent = flatParent(engine, op.parent);
    if (flat.nodes.get(parent)?.kind !== "folder") break;
    if (op.op === "add" && node && op.ifAbsent) continue;
    if (op.op === "move" || node) {
      if (!node || node.parent === null || inside(op.id, parent)) break;
      detach(op.id);
      attach(op.id, parent, op.index);
      if (op.op === "add") flat.nodes.set(op.id, { ...flat.nodes.get(op.id)!, title: op.t, ...(op.u && node.kind === "url" && keepsUrl(op.u) ? { url: op.u } : {}) });
      continue;
    }
    if (op.k === "u" && !keepsUrl(op.u ?? "")) continue;
    flat.nodes.set(op.id, {
      kind: op.k === "u" ? "url" : "folder",
      parent,
      title: op.t,
      ...(op.k === "u" ? { url: op.u ?? "" } : {}),
      addedAt: op.a,
      ...(op.key ? { key: op.key } : {}),
    });
    if (op.k === "f") flat.children.set(op.id, []);
    attach(op.id, parent, op.index);
  }
  return flat;
}
