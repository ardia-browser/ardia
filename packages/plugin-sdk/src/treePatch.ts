import type { PluginNode } from "./protocol";

export type TreeChild = PluginNode | string;

export type TreePath = number[];

export type TreeOp =
  | { op: "replace"; path: TreePath; node: TreeChild }
  | { op: "props"; path: TreePath; set?: Record<string, unknown>; unset?: string[] }
  | { op: "insert"; path: TreePath; index: number; nodes: TreeChild[] }
  | { op: "remove"; path: TreePath; index: number; count: number };

export type SurfacePatchParams = { surfaceId: string; base: number; rev: number; ops: TreeOp[] };

export class TreePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreePatchError";
  }
}

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const MAX_DEPTH = 256;
const NODE_KEYS = new Set(["type", "key", "props", "children"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const dense = (items: readonly unknown[], check: (item: unknown) => boolean) => {
  for (let i = 0; i < items.length; i++) if (!(i in items) || !check(items[i])) return false;
  return true;
};

const definedKeys = (record: Record<string, unknown>) => Object.keys(record).filter((key) => record[key] !== undefined);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = definedKeys(left);
  if (keys.length !== definedKeys(right).length) return false;
  return keys.every((key) => right[key] !== undefined && deepEqual(left[key], right[key]));
}

function safeValue(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return dense(value, (item) => safeValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => !FORBIDDEN_KEYS.has(key) && (value[key] === undefined || safeValue(value[key], depth + 1)));
}

function validChild(value: unknown, depth: number): value is TreeChild {
  if (typeof value === "string") return true;
  if (depth > MAX_DEPTH || !isRecord(value)) return false;
  if (!Object.keys(value).every((key) => NODE_KEYS.has(key))) return false;
  const { type, key, props, children } = value;
  if (typeof type !== "string" || !type) return false;
  if (key !== undefined && typeof key !== "string" && !(typeof key === "number" && Number.isFinite(key))) return false;
  if (!isRecord(props) || !safeValue(props, depth + 1)) return false;
  return Array.isArray(children) && dense(children, (child) => validChild(child, depth + 1));
}

export const isTreeNode = (value: unknown): value is PluginNode => typeof value !== "string" && validChild(value, 0);

const sameIdentity = (a: TreeChild | undefined, b: TreeChild | undefined): boolean => {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return typeof a === typeof b;
  return a.type === b.type && (a.key ?? null) === (b.key ?? null);
};

function withoutUndefined(node: TreeChild): TreeChild {
  if (typeof node === "string") return node;
  const props: Record<string, unknown> = {};
  for (const key of definedKeys(node.props)) props[key] = node.props[key];
  return { ...node, props, children: node.children.map(withoutUndefined) };
}

function diffProps(a: PluginNode, b: PluginNode, path: TreePath, ops: TreeOp[]) {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of definedKeys(b.props)) if (!deepEqual(a.props[key], b.props[key])) set[key] = b.props[key];
  for (const key of definedKeys(a.props)) if (b.props[key] === undefined) unset.push(key);
  if (Object.keys(set).length || unset.length) ops.push({ op: "props", path, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
}

function diffChildren(a: readonly TreeChild[], b: readonly TreeChild[], path: TreePath, ops: TreeOp[]) {
  let start = 0;
  while (start < a.length && start < b.length && sameIdentity(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sameIdentity(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  for (let i = 0; i < start; i++) diffNode(a[i]!, b[i]!, [...path, i], ops);
  const removed = endA - start;
  const added = endB - start;
  if (removed === added) {
    for (let i = start; i < endA; i++) diffNode(a[i]!, b[i]!, [...path, i], ops);
  } else {
    if (removed) ops.push({ op: "remove", path, index: start, count: removed });
    if (added) ops.push({ op: "insert", path, index: start, nodes: b.slice(start, endB).map(withoutUndefined) });
  }
  for (let i = 0; i < a.length - endA; i++) diffNode(a[endA + i]!, b[endB + i]!, [...path, endB + i], ops);
}

function diffNode(a: TreeChild, b: TreeChild, path: TreePath, ops: TreeOp[]) {
  if (a === b) return;
  if (typeof a === "string" || typeof b === "string" || !sameIdentity(a, b)) {
    if (!deepEqual(a, b)) ops.push({ op: "replace", path, node: withoutUndefined(b) });
    return;
  }
  diffProps(a, b, path, ops);
  diffChildren(a.children, b.children, path, ops);
}

export function diffTree(previous: PluginNode | null | undefined, next: PluginNode): TreeOp[] {
  if (!previous) return [{ op: "replace", path: [], node: withoutUndefined(next) }];
  const ops: TreeOp[] = [];
  diffNode(previous, next, [], ops);
  return ops;
}

const isPath = (value: unknown): value is TreePath => Array.isArray(value) && value.length <= MAX_DEPTH && value.every((i) => Number.isInteger(i) && i >= 0);

function update(node: TreeChild, path: TreePath, depth: number, change: (target: TreeChild) => TreeChild): TreeChild {
  if (depth === path.length) return change(node);
  if (typeof node === "string") throw new TreePatchError(`The patch path ${path.join("/")} goes through text`);
  const index = path[depth]!;
  const child = node.children[index];
  if (child === undefined) throw new TreePatchError(`The patch path ${path.join("/")} has no child at ${index}`);
  const children = node.children.slice();
  children[index] = update(child, path, depth + 1, change);
  return { ...node, children };
}

const asNode = (target: TreeChild, op: string): PluginNode => {
  if (typeof target === "string") throw new TreePatchError(`A ${op} op can't target text`);
  return target;
};

function applyOne(tree: TreeChild, op: TreeOp): TreeChild {
  if (!isRecord(op) || !isPath((op as { path?: unknown }).path)) throw new TreePatchError("A patch op needs a path");
  switch (op.op) {
    case "replace":
      if (!validChild(op.node, op.path.length)) throw new TreePatchError("A replace op needs a well-formed node");
      if (op.path.length === 0 && typeof op.node === "string") throw new TreePatchError("The root must be a node, not text");
      return update(tree, op.path, 0, () => op.node);
    case "props": {
      const set: unknown = op.set === undefined ? {} : op.set;
      const unset: unknown = op.unset === undefined ? [] : op.unset;
      if (!isRecord(set) || !safeValue(set, op.path.length)) throw new TreePatchError("A props op's set must be an object of plain values with no __proto__, constructor or prototype keys");
      if (!Array.isArray(unset) || !unset.every((key) => typeof key === "string" && !FORBIDDEN_KEYS.has(key))) throw new TreePatchError("A props op's unset must list prop names");
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "props");
        const props: Record<string, unknown> = { ...node.props };
        for (const key of Object.keys(set)) {
          if (set[key] === undefined) delete props[key];
          else props[key] = set[key];
        }
        for (const key of unset) delete props[key];
        return { ...node, props };
      });
    }
    case "insert":
      if (!Array.isArray(op.nodes) || !dense(op.nodes, (n) => validChild(n, op.path.length + 1))) throw new TreePatchError("An insert op needs well-formed nodes");
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "insert");
        if (!Number.isInteger(op.index) || op.index < 0 || op.index > node.children.length) throw new TreePatchError(`Can't insert at ${op.index}`);
        const children = node.children.slice();
        children.splice(op.index, 0, ...op.nodes);
        return { ...node, children };
      });
    case "remove":
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "remove");
        if (!Number.isInteger(op.index) || !Number.isInteger(op.count) || op.index < 0 || op.count < 1 || op.index + op.count > node.children.length) {
          throw new TreePatchError(`Can't remove ${op.count} at ${op.index}`);
        }
        const children = node.children.slice();
        children.splice(op.index, op.count);
        return { ...node, children };
      });
    default:
      throw new TreePatchError(`Unknown patch op ${String((op as { op?: unknown }).op)}`);
  }
}

export function applyTreePatch(tree: PluginNode | null, ops: readonly TreeOp[]): PluginNode {
  if (!Array.isArray(ops)) throw new TreePatchError("A patch is a list of ops");
  let current: TreeChild | null = tree;
  for (const op of ops) {
    if (current === null) {
      if (!isRecord(op) || op.op !== "replace" || !isPath(op.path) || op.path.length !== 0) throw new TreePatchError("A patch on no tree must start by replacing the root");
      if (!isTreeNode(op.node)) throw new TreePatchError("The root must be a well-formed node");
      current = op.node;
      continue;
    }
    current = applyOne(current, op);
  }
  if (current === null || typeof current === "string") throw new TreePatchError("A patch must leave a node at the root");
  return current;
}
