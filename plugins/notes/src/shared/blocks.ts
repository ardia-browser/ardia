import * as Y from "yjs";
import { blocksOf, newId } from "./model";

export type InlineNode = { node: string; attrs: Record<string, unknown> };
export type Inline = string | { text: string; marks?: Record<string, unknown> } | InlineNode;
export type BlockSpec = { type: string; attrs?: Record<string, unknown>; content?: Inline[]; children?: BlockSpec[] };

export const LAYOUT_BLOCKS = new Set(["columnList", "column"]);

const isNode = (part: Inline): part is InlineNode => typeof part === "object" && "node" in part;

function inlineNodes(parts: Inline[]): (Y.XmlText | Y.XmlElement)[] {
  const out: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  let at = 0;
  for (const part of parts) {
    if (isNode(part)) {
      const el = new Y.XmlElement(part.node);
      for (const [k, v] of Object.entries(part.attrs)) el.setAttribute(k, v as string);
      out.push(el);
      text = null;
      continue;
    }
    const value = typeof part === "string" ? part : part.text;
    if (!value) continue;
    if (!text) {
      text = new Y.XmlText();
      at = 0;
      out.push(text);
    }
    text.insert(at, value, (typeof part === "string" ? undefined : part.marks) ?? {});
    at += value.length;
  }
  return out;
}

function layoutNode(spec: BlockSpec): Y.XmlElement {
  const el = new Y.XmlElement(spec.type);
  el.setAttribute("id", newId());
  for (const [k, v] of Object.entries(spec.attrs ?? {})) el.setAttribute(k, v as string);
  const children = spec.children ?? [];
  if (children.length) el.insert(0, children.map((c) => (spec.type === "columnList" ? layoutNode({ ...c, type: "column" }) : blockNode(c))));
  return el;
}

function blockContainer(spec: BlockSpec): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", newId());
  const content = new Y.XmlElement(spec.type);
  for (const [k, v] of Object.entries(spec.attrs ?? {})) content.setAttribute(k, v as string);
  if (spec.content && spec.content.length) {
    const nodes = inlineNodes(spec.content);
    if (nodes.length) content.insert(0, nodes);
  }
  container.insert(0, [content]);
  if (spec.children?.length) container.insert(1, [blockGroup(spec.children)]);
  return container;
}

function blockNode(spec: BlockSpec): Y.XmlElement {
  return LAYOUT_BLOCKS.has(spec.type) ? layoutNode(spec) : blockContainer(spec);
}

function blockGroup(specs: BlockSpec[]): Y.XmlElement {
  const group = new Y.XmlElement("blockGroup");
  group.insert(
    0,
    specs.map((s) => blockNode(s)),
  );
  return group;
}

export function writeBlocks(doc: Y.Doc, specs: BlockSpec[]) {
  const fragment = blocksOf(doc);
  doc.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    fragment.insert(0, [blockGroup(specs)]);
  });
}

const BLANK_NODES = new Set(["blockGroup", "blockContainer", "paragraph"]);

export function isBlankFragment(fragment: Y.XmlFragment | Y.XmlElement): boolean {
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) {
      if (child.length > 0) return false;
      continue;
    }
    if (!(child instanceof Y.XmlElement) || !BLANK_NODES.has(child.nodeName) || !isBlankFragment(child)) return false;
  }
  return true;
}
