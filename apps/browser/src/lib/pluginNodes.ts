import { isFields } from "./decode";
import type { PluginNode, QuickPickItem, QuickPickOptions, InputBoxOptions, ToolbarUpdate } from "./pluginProtocol";
import { TONES } from "./pluginProtocol";
import { pluginShortcutOf, pluginShortcutText } from "./pluginShortcuts";
import { t } from "./uiLanguage";


export const NODE_LIMITS = { depth: 24, nodes: 2000, textBytes: 256 * 1024, props: 32, propBytes: 16 * 1024, items: 500 } as const;

const NODE_TYPE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const PROP_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const SYMBOL = /^[a-z0-9.]{1,64}$/;
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

export type NodeCheck = { ok: true; tree: PluginNode } | { ok: false; problem: string };

type Budget = { nodes: number; bytes: number };

const clean = (text: string) => text.replace(UNSAFE, "");

function propValue(value: unknown, budget: Budget, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    budget.bytes += value.length;
    return clean(value);
  }
  if (depth > 4) throw new Error(t(`has props nested too deep`));
  if (Array.isArray(value)) {
    if (value.length > NODE_LIMITS.items) throw new Error(`has a prop list over ${NODE_LIMITS.items}`);
    return value.map((v) => propValue(v, budget, depth + 1));
  }
  if (isFields(value)) return Object.fromEntries(Object.entries(value).slice(0, NODE_LIMITS.props).map(([k, v]) => [k, propValue(v, budget, depth + 1)]));
  return null;
}

function nodeOf(raw: unknown, budget: Budget, depth: number): PluginNode | string {
  if (typeof raw === "string") {
    budget.bytes += raw.length;
    return clean(raw);
  }
  if (typeof raw === "number") return String(raw);
  if (depth > NODE_LIMITS.depth) throw new Error(`nests deeper than ${NODE_LIMITS.depth}`);
  if (++budget.nodes > NODE_LIMITS.nodes) throw new Error(`has more than ${NODE_LIMITS.nodes} nodes`);
  if (!isFields(raw)) throw new Error(t(`has a node that isn't an object or text`));
  if (typeof raw.type !== "string" || !NODE_TYPE.test(raw.type)) throw new Error(t(`has a node whose type isn't a component name`));
  const props: Record<string, unknown> = {};
  if (raw.props !== undefined && !isFields(raw.props)) throw new Error(t(`has props that aren't an object`));
  const given = Object.entries((raw.props as Record<string, unknown> | undefined) ?? {});
  if (given.length > NODE_LIMITS.props) throw new Error(`has a node with more than ${NODE_LIMITS.props} props`);
  for (const [name, value] of given) {
    if (!PROP_NAME.test(name)) throw new Error(`has a prop named ${JSON.stringify(name.slice(0, 40))}`);
    if (name === "shortcut") {
      const shortcut = pluginShortcutOf(value);
      if (shortcut) props.shortcut = pluginShortcutText(shortcut);
      continue;
    }
    const before = budget.bytes;
    props[name] = propValue(value, budget, 0);
    if (budget.bytes - before > NODE_LIMITS.propBytes) throw new Error(`has a prop over ${NODE_LIMITS.propBytes / 1024} KB`);
  }
  const children = raw.children === undefined ? [] : Array.isArray(raw.children) ? raw.children : null;
  if (!children) throw new Error(t(`has children that aren't a list`));
  const key = typeof raw.key === "string" ? raw.key.slice(0, 200) : typeof raw.key === "number" && Number.isFinite(raw.key) ? raw.key : undefined;
  const node: PluginNode = { type: raw.type, props, children: children.flatMap((child) => (child === null || child === undefined || typeof child === "boolean" ? [] : [nodeOf(child, budget, depth + 1)])) };
  if (key !== undefined) node.key = key;
  if (budget.bytes > NODE_LIMITS.textBytes) throw new Error(`has over ${NODE_LIMITS.textBytes / 1024} KB of text`);
  return node;
}

export function checkPluginNode(raw: unknown): NodeCheck {
  try {
    const tree = nodeOf(raw, { nodes: 0, bytes: 0 }, 0);
    if (typeof tree === "string") return { ok: false, problem: t(`must be a node, not text`) };
    return { ok: true, tree };
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }
}

const shortText = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? clean(value).slice(0, max) : undefined);
const symbolOrUndefined = (value: unknown) => (typeof value === "string" && SYMBOL.test(value) ? value : undefined);

export function quickPickItemsOf(raw: unknown): QuickPickItem[] | null {
  if (!Array.isArray(raw) || raw.length > NODE_LIMITS.items) return null;
  const items: QuickPickItem[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isFields(value)) return null;
    const id = shortText(value.id, 200);
    const title = shortText(value.title, 200);
    if (!id || !title || seen.has(id)) return null;
    seen.add(id);
    const keywords = Array.isArray(value.keywords) ? value.keywords.flatMap((k) => shortText(k, 40) ?? []).slice(0, 8) : undefined;
    const item: QuickPickItem = { id, title };
    const subtitle = shortText(value.subtitle, 200);
    const icon = symbolOrUndefined(value.icon);
    const badge = shortText(value.badge, 24);
    if (subtitle) item.subtitle = subtitle;
    if (icon) item.icon = icon;
    if (badge) item.badge = badge;
    if (keywords?.length) item.keywords = keywords;
    if (value.picked === true) item.picked = true;
    items.push(item);
  }
  return items;
}

export function quickPickOptionsOf(raw: unknown): QuickPickOptions {
  const doc = isFields(raw) ? raw : {};
  const out: QuickPickOptions = {};
  const title = shortText(doc.title, 80);
  const placeholder = shortText(doc.placeholder, 120);
  if (title) out.title = title;
  if (placeholder) out.placeholder = placeholder;
  if (doc.canPickMany === true) out.canPickMany = true;
  return out;
}

export function inputBoxOptionsOf(raw: unknown): InputBoxOptions | null {
  if (!isFields(raw)) return null;
  const title = shortText(raw.title, 80);
  if (!title) return null;
  const out: InputBoxOptions = { title };
  const message = shortText(raw.message, 400);
  const placeholder = shortText(raw.placeholder, 120);
  const value = typeof raw.value === "string" ? clean(raw.value).slice(0, 2000) : undefined;
  const confirmTitle = shortText(raw.confirmTitle, 30);
  if (message) out.message = message;
  if (placeholder) out.placeholder = placeholder;
  if (value !== undefined) out.value = value;
  if (raw.password === true) out.password = true;
  if (confirmTitle) out.confirmTitle = confirmTitle;
  return out;
}

export function toolbarUpdateOf(raw: unknown): ToolbarUpdate | null {
  if (!isFields(raw)) return null;
  const out: ToolbarUpdate = {};
  if (raw.icon !== undefined) {
    const icon = symbolOrUndefined(raw.icon);
    if (!icon) return null;
    out.icon = icon;
  }
  if (raw.label !== undefined) out.label = raw.label === null ? null : (shortText(raw.label, 24) ?? null);
  if (raw.tooltip !== undefined) out.tooltip = raw.tooltip === null ? null : (shortText(raw.tooltip, 120) ?? null);
  if (raw.badge !== undefined) {
    const badge = raw.badge;
    if (badge === null || typeof badge === "boolean") out.badge = badge;
    else if (typeof badge === "number" && Number.isFinite(badge)) out.badge = Math.max(-9999, Math.min(9999, Math.round(badge)));
    else if (typeof badge === "string") out.badge = clean(badge).slice(0, 6);
    else return null;
  }
  if (raw.tone !== undefined) {
    if (!(TONES as readonly unknown[]).includes(raw.tone)) return null;
    out.tone = raw.tone as ToolbarUpdate["tone"];
  }
  return out;
}
