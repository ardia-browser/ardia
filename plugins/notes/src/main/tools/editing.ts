import * as Y from "yjs";
import { BLOCKS, buildBlock, buildContentNode, buildGroup, blockText, emptyParagraph, inlinePieces, readBlockElement, readInline, rootGroup, type Block, type Inline, type Piece } from "./blocks";
import { ToolError, closest } from "./spec";

const LAYOUT = new Set(["columnList", "column"]);
const BLOCKISH = new Set(["blockContainer", "columnList", "column"]);

export type Located = { el: Y.XmlElement; parent: Y.XmlElement; index: number };

export function blockIndex(fragment: Y.XmlFragment): Map<string, Y.XmlElement> {
  const out = new Map<string, Y.XmlElement>();
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (BLOCKISH.has(child.nodeName)) {
        const id = child.getAttribute("id");
        if (typeof id === "string" && id) out.set(id, child);
      }
      if (BLOCKISH.has(child.nodeName) || child.nodeName === "blockGroup") walk(child);
    }
  };
  walk(fragment);
  return out;
}

export function locate(index: Map<string, Y.XmlElement>, id: string, path: string): Located {
  const el = index.get(id);
  if (!el || !(el.parent instanceof Y.XmlElement)) {
    const near = closest(id, index.keys());
    throw new ToolError(`${path}: there's no block '${id.slice(0, 64)}' on this page${near ? `; did you mean '${near}'?` : ""}. Read the page with content get {format: "blocks"} for ids.`);
  }
  const parent = el.parent;
  return { el, parent, index: parent.toArray().indexOf(el) };
}

export const contentNodeOf = (container: Y.XmlElement): Y.XmlElement | null =>
  container.nodeName === "blockContainer" ? (container.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName !== "blockGroup") ?? null) : null;

export const childGroupOf = (container: Y.XmlElement): Y.XmlElement | null =>
  container.nodeName === "blockContainer" ? (container.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === "blockGroup") ?? null) : container;

export function ensureRoot(fragment: Y.XmlFragment): Y.XmlElement {
  let root = rootGroup(fragment);
  if (!root) {
    if (fragment.length) fragment.delete(0, fragment.length);
    root = new Y.XmlElement("blockGroup");
    fragment.insert(0, [root]);
  }
  return root;
}

function kindOfParent(parent: Y.XmlElement): "columnList" | "column" | "group" {
  return parent.nodeName === "columnList" ? "columnList" : parent.nodeName === "column" ? "column" : "group";
}

export function checkFits(parent: Y.XmlElement, blocks: Block[], path: string) {
  const kind = kindOfParent(parent);
  for (const b of blocks) {
    if (kind === "columnList" && b.type !== "column") throw new ToolError(`${path}: only column blocks go inside a columnList.`);
    if (kind !== "columnList" && b.type === "column") throw new ToolError(`${path}: a column block goes only inside a columnList.`);
    if (kind === "column" && b.type === "columnList") throw new ToolError(`${path}: columns can't nest inside a column.`);
  }
}

export function childTarget(container: Y.XmlElement): Y.XmlElement {
  if (container.nodeName !== "blockContainer") return container;
  let group = childGroupOf(container);
  if (!group) {
    group = new Y.XmlElement("blockGroup");
    container.insert(container.length, [group]);
  }
  return group;
}

export function removeAt(parent: Y.XmlElement, index: number) {
  parent.delete(index, 1);
  if (parent.length > 0) return;
  if (parent.nodeName === "blockGroup" && parent.parent instanceof Y.XmlElement && parent.parent.nodeName === "blockContainer") {
    const owner = parent.parent;
    owner.delete(owner.toArray().indexOf(parent), 1);
  } else if (parent.nodeName === "blockGroup" || parent.nodeName === "column") parent.insert(0, [buildBlock(emptyParagraph())]);
}

type Token = { ch: string; key: string; attrs: Record<string, unknown> };

const styleKey = (attrs: Record<string, unknown> | undefined) => {
  const keys = Object.keys(attrs ?? {}).filter((k) => !k.startsWith("comment")).sort();
  return keys.map((k) => `${k}=${JSON.stringify((attrs as Record<string, unknown>)[k])}`).join(";");
};

function tokensOf(text: Y.XmlText): Token[] {
  const out: Token[] = [];
  for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert !== "string") continue;
    const key = styleKey(op.attributes);
    for (const ch of op.insert) out.push({ ch, key, attrs: op.attributes ?? {} });
  }
  return out;
}

function piecesTokens(pieces: Piece[]): Token[] | null {
  const out: Token[] = [];
  for (const p of pieces) {
    if (p.kind !== "text") return null;
    const key = styleKey(p.attrs);
    for (const ch of p.text) out.push({ ch, key, attrs: p.attrs });
  }
  return out;
}

function sameAttrsIgnoringComments(a: Record<string, unknown>, b: Record<string, unknown>) {
  return styleKey(a) === styleKey(b);
}

export function setInline(node: Y.XmlElement, content: Inline[], plain: boolean) {
  const pieces = inlinePieces(content, plain);
  const kids = node.toArray();
  const wanted = piecesTokens(pieces);
  const onlyText = kids.every((k) => k instanceof Y.XmlText);
  if (wanted && onlyText && kids.length <= 1) {
    let text = kids[0] as Y.XmlText | undefined;
    if (!text) {
      if (!wanted.length) return;
      text = new Y.XmlText();
      node.insert(0, [text]);
    }
    const have = tokensOf(text);
    let start = 0;
    while (start < have.length && start < wanted.length && have[start]!.ch === wanted[start]!.ch && have[start]!.key === wanted[start]!.key) start++;
    let endHave = have.length;
    let endWant = wanted.length;
    while (endHave > start && endWant > start && have[endHave - 1]!.ch === wanted[endWant - 1]!.ch && have[endHave - 1]!.key === wanted[endWant - 1]!.key) {
      endHave--;
      endWant--;
    }
    const unit = (tokens: Token[], from: number, to: number) => tokens.slice(from, to).map((t) => t.ch).join("").length;
    const offset = unit(have, 0, start);
    const removeLen = unit(have, start, endHave);
    if (removeLen) text.delete(offset, removeLen);
    let at = offset;
    let i = start;
    while (i < endWant) {
      const attrs = wanted[i]!.attrs;
      let j = i;
      let run = "";
      while (j < endWant && sameAttrsIgnoringComments(wanted[j]!.attrs, attrs)) run += wanted[j++]!.ch;
      text.insert(at, run, attrs);
      at += run.length;
      i = j;
    }
    return;
  }
  if (kids.length) node.delete(0, kids.length);
  const fresh: (Y.XmlText | Y.XmlElement)[] = [];
  let current: Y.XmlText | null = null;
  let at = 0;
  for (const p of pieces) {
    if (p.kind === "el") {
      fresh.push(p.make());
      current = null;
      continue;
    }
    if (!current) {
      current = new Y.XmlText();
      at = 0;
      fresh.push(current);
    }
    current.insert(at, p.text, p.attrs);
    at += p.text.length;
  }
  if (fresh.length) node.insert(0, fresh);
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function updateBlockInPlace(el: Y.XmlElement, next: Block, options: { props: "replace" | "merge"; content: boolean }) {
  const def = BLOCKS[next.type]!;
  if (LAYOUT.has(el.nodeName)) {
    if (el.nodeName !== next.type) throw new ToolError(`a ${el.nodeName} block can't become a ${next.type}; delete it and insert a new block.`);
    applyAttrs(el, next.props, options.props, def.props);
    return;
  }
  const node = contentNodeOf(el);
  if (!node || node.nodeName !== next.type) {
    const old = node ? readBlockElement(el) : null;
    const carried: Block = { ...next };
    if (!options.content && old && Array.isArray(old.content) && (def.content === "inline" || def.content === "plain")) carried.content = def.content === "plain" ? ([{ type: "text", text: blockText(old), styles: {} }] as Inline[]).filter((t) => t.type === "text" && t.text) : old.content;
    if (options.props === "merge" && old) {
      const keep: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(old.props)) if (def.props[k]) keep[k] = v;
      carried.props = { ...keep, ...next.props };
    }
    const fresh = buildContentNode(carried);
    if (node) el.delete(el.toArray().indexOf(node), 1);
    el.insert(0, [fresh]);
    return;
  }
  applyAttrs(node, next.props, options.props, def.props);
  if (!options.content) return;
  if (def.content === "inline" || def.content === "plain") setInline(node, (next.content as Inline[]) ?? [], def.content === "plain");
  else if (def.content === "table") {
    const current = readBlockElement(el);
    if (!sameJson(current?.content, next.content)) {
      const fresh = buildContentNode(next);
      el.delete(el.toArray().indexOf(node), 1);
      el.insert(0, [fresh]);
    }
  }
}

function applyAttrs(node: Y.XmlElement, props: Record<string, unknown>, mode: "replace" | "merge", defs: Record<string, { default: unknown }>) {
  const attrs = node.getAttributes() as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) {
    if (v === null) {
      if (k in attrs) node.removeAttribute(k);
    } else if (attrs[k] !== v) node.setAttribute(k, v as string);
  }
  if (mode === "replace") for (const k of Object.keys(attrs)) if (k !== "id" && defs[k] && !(k in props) && attrs[k] !== defs[k]!.default) node.removeAttribute(k);
}

const signature = (b: Block) => `${b.type}\u0000${blockText(b)}`;

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [];
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

function lis(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(values.length).fill(-1);
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k]!;
  }
  return keep;
}

export type ReconcileStats = { kept: number; updated: number; inserted: number; deleted: number; moved: number };

export function reconcile(parent: Y.XmlElement, wanted: Block[], stats: ReconcileStats, matchByContent = true) {
  const elements = parent.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && BLOCKISH.has(c.nodeName));
  const old = elements.map((el) => readBlockElement(el)!);
  const pair = new Array<number>(wanted.length).fill(-1);
  const taken = new Set<number>();
  const oldById = new Map(old.map((b, i) => [b.id, i]));
  wanted.forEach((b, j) => {
    const i = oldById.get(b.id);
    if (i !== undefined && !taken.has(i)) {
      pair[j] = i;
      taken.add(i);
    }
  });
  if (matchByContent) {
    const freeOld = old.map((_, i) => i).filter((i) => !taken.has(i));
    const freeNew = wanted.map((_, j) => j).filter((j) => pair[j] === -1);
    for (const [a, b] of lcs(freeOld.map((i) => signature(old[i]!)), freeNew.map((j) => signature(wanted[j]!)))) {
      pair[freeNew[b]!] = freeOld[a]!;
      taken.add(freeOld[a]!);
    }
    let lastOld = -1;
    for (let j = 0; j < wanted.length; j++) {
      if (pair[j] !== -1) {
        lastOld = Math.max(lastOld, pair[j]!);
        continue;
      }
      let nextPairedOld = old.length;
      for (let k = j + 1; k < wanted.length; k++)
        if (pair[k] !== -1) {
          nextPairedOld = pair[k]!;
          break;
        }
      for (let i = lastOld + 1; i < nextPairedOld; i++) {
        if (taken.has(i) || old[i]!.type !== wanted[j]!.type || LAYOUT.has(old[i]!.type) !== LAYOUT.has(wanted[j]!.type)) continue;
        pair[j] = i;
        taken.add(i);
        lastOld = i;
        break;
      }
    }
  }
  const pairedNew = wanted.map((_, j) => j).filter((j) => pair[j] !== -1);
  const keepIdx = lis(pairedNew.map((j) => pair[j]!));
  const stays = new Set<number>();
  pairedNew.forEach((j, k) => {
    if (keepIdx.has(k)) stays.add(j);
  });
  const staysOld = new Set([...stays].map((j) => pair[j]!));
  const moved = new Map<number, Block>();
  for (let i = old.length - 1; i >= 0; i--) {
    if (staysOld.has(i)) continue;
    const at = parent.toArray().indexOf(elements[i]!);
    if (taken.has(i)) moved.set(i, old[i]!);
    else stats.deleted++;
    parent.delete(at, 1);
  }
  let position = 0;
  for (let j = 0; j < wanted.length; j++) {
    const want = wanted[j]!;
    if (stays.has(j)) {
      const el = elements[pair[j]!]!;
      position = parent.toArray().indexOf(el) + 1;
      const before = old[pair[j]!]!;
      const same = sameJson({ t: before.type, p: before.props, c: before.content ?? null }, { t: want.type, p: want.props, c: want.content ?? null });
      if (!same) {
        updateBlockInPlace(el, want, { props: "replace", content: true });
        stats.updated++;
      } else stats.kept++;
      reconcileChildren(el, want, stats);
      continue;
    }
    const fresh = buildBlock(pair[j] !== -1 ? { ...want, id: old[pair[j]!]!.id } : want);
    parent.insert(position, [fresh]);
    position++;
    if (pair[j] !== -1) stats.moved++;
    else stats.inserted++;
  }
  if (parent.length === 0 && parent.nodeName === "blockGroup") parent.insert(0, [buildBlock(emptyParagraph())]);
}

function reconcileChildren(el: Y.XmlElement, want: Block, stats: ReconcileStats) {
  if (el.nodeName === "blockContainer") {
    let group = childGroupOf(el);
    if (!want.children.length) {
      if (group) {
        stats.deleted += group.toArray().filter((c) => c instanceof Y.XmlElement).length;
        el.delete(el.toArray().indexOf(group), 1);
      }
      return;
    }
    if (!group) {
      el.insert(el.length, [buildGroup(want.children)]);
      stats.inserted += want.children.length;
      return;
    }
    reconcile(group, want.children, stats);
    return;
  }
  reconcile(el, want.children, stats);
}

export function readInlineOf(el: Y.XmlElement): Inline[] {
  const node = contentNodeOf(el);
  return node ? readInline(node) : [];
}
