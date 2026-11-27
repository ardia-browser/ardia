import { AUTOCAPTURE_PRIVATE_SELECTOR, NO_CAPTURE_SELECTOR } from "../../data/telemetry.ts";

export const HIDDEN_TEXT_SELECTOR = `${AUTOCAPTURE_PRIVATE_SELECTOR}, ${NO_CAPTURE_SELECTOR}`;
export const TEXT_MAX = 255;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FIELD = /^(input|textarea|select|option)$/;
const WALK_BUDGET = TEXT_MAX * 4;

export interface TextNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<TextNodeLike>;
}
export interface TextElementLike extends TextNodeLike {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  matches(selector: string): boolean;
  closest(selector: string): unknown;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
export const sensitive = (s: string) => /\b(?:\d[ -]?){13,16}\b/.test(s) || /\b\d{3}-\d{2}-\d{4}\b/.test(s);
export const isField = (el: TextElementLike) => FIELD.test(el.tagName.toLowerCase()) || el.isContentEditable === true;
export const textIsHidden = (el: TextElementLike) => !!el.closest(HIDDEN_TEXT_SELECTOR);

const finish = (parts: string[]) => {
  const cut = clean(parts.join(" ")).slice(0, TEXT_MAX);
  return sensitive(cut) || sensitive(clean(parts.join(""))) ? "" : cut;
};

export function ownText(el: TextElementLike): string {
  if (isField(el) || textIsHidden(el)) return "";
  const parts: string[] = [];
  for (const node of Array.from(el.childNodes)) if (node.nodeType === TEXT_NODE) parts.push(node.textContent ?? "");
  return finish(parts);
}

export function elementText(el: TextElementLike): string {
  if (isField(el) || textIsHidden(el)) return "";
  const own = ownText(el);
  if (own) return own;
  const parts: string[] = [];
  let length = 0;
  const walk = (node: TextNodeLike) => {
    for (const child of Array.from(node.childNodes)) {
      if (length > WALK_BUDGET) return;
      if (child.nodeType === TEXT_NODE) {
        parts.push(child.textContent ?? "");
        length += (child.textContent ?? "").length + 1;
      } else if (child.nodeType === ELEMENT_NODE) {
        const element = child as TextElementLike;
        if (!isField(element) && !element.matches(HIDDEN_TEXT_SELECTOR)) walk(element);
      }
    }
  };
  walk(el);
  return finish(parts);
}
