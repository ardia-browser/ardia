import * as Y from "yjs";
import { hex } from "../../shared/bytes";
import { Sha256 } from "../sha256";

const BASE_KEY = "imported";
const QUIET_VALUES = new Set(["default", "left", "false", ""]);

export const printOf = (text: string): string => hex(new Sha256().update(new TextEncoder().encode(text)).digest().subarray(0, 8));

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Uint8Array))
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null) ?? "null";
}

const valuePrint = (value: unknown) => printOf(stableJson(value === undefined ? null : value));

function canonical(node: unknown): string {
  if (node instanceof Y.XmlText) return stableJson(node.toDelta());
  if (!(node instanceof Y.XmlElement)) return "";
  const attrs = Object.entries(node.getAttributes() as Record<string, unknown>)
    .filter(([k, v]) => k !== "id" && v !== null && v !== undefined && !QUIET_VALUES.has(String(v)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${stableJson(v)}`)
    .join(" ");
  return `<${node.nodeName} ${attrs}>${node.toArray().map(canonical).join("")}</>`;
}

function emptyBlock(node: unknown): boolean {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer" || node.length !== 1) return false;
  const content = node.get(0);
  return content instanceof Y.XmlElement && content.nodeName === "paragraph" && content.toArray().every((c) => c instanceof Y.XmlText && c.length === 0);
}

export function bodyPrint(fragment: Y.XmlFragment): string {
  const parts: string[] = [];
  for (const top of fragment.toArray()) {
    if (top instanceof Y.XmlElement && top.nodeName === "blockGroup") {
      const kids = top.toArray();
      while (kids.length && emptyBlock(kids[kids.length - 1])) kids.pop();
      parts.push(...kids.map(canonical));
    } else parts.push(canonical(top));
  }
  return printOf(parts.join(""));
}

export const EMPTY_BODY = printOf("");

export function seedBody(doc: Y.Doc, page: string, print: string, fill: (scratch: Y.Doc) => void) {
  const scratch = new Y.Doc();
  scratch.clientID = (parseInt(printOf(`seed:${page}:${print}`).slice(0, 8), 16) >>> 1) + 1;
  try {
    fill(scratch);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch));
  } finally {
    scratch.destroy();
  }
}

function baseOf(entry: Y.Map<unknown>): Y.Map<unknown> {
  const found = entry.get(BASE_KEY);
  if (found instanceof Y.Map) return found;
  const made = new Y.Map<unknown>();
  entry.set(BASE_KEY, made);
  return made;
}

const peekBase = (entry: Y.Map<unknown>, key: string): string | undefined => {
  const found = entry.get(BASE_KEY);
  const value = found instanceof Y.Map ? found.get(key) : undefined;
  return typeof value === "string" ? value : undefined;
};

export class Rebase {
  readonly conflicts = new Set<string>();

  remember(entry: Y.Map<unknown>, key: string, value: unknown) {
    const print = valuePrint(value);
    if (peekBase(entry, `f:${key}`) !== print) baseOf(entry).set(`f:${key}`, print);
  }

  field(page: string, entry: Y.Map<unknown>, key: string, current: unknown, incoming: unknown, apply: () => void) {
    const inc = valuePrint(incoming);
    const cur = valuePrint(current);
    const base = peekBase(entry, `f:${key}`);
    const keep = () => {
      if (base !== inc) baseOf(entry).set(`f:${key}`, inc);
    };
    if (inc === cur) return keep();
    if (base === undefined || base === cur) {
      apply();
      return keep();
    }
    if (base !== inc) this.conflicts.add(page);
  }

  body(page: string, entry: Y.Map<unknown> | undefined, current: string, incoming: string, existed: boolean): boolean {
    const base = entry ? peekBase(entry, "body") : undefined;
    const keep = () => {
      if (entry && base !== incoming) baseOf(entry).set("body", incoming);
    };
    if (!existed || incoming === current || current === EMPTY_BODY) {
      keep();
      return incoming !== current;
    }
    if (base === undefined) {
      keep();
      this.conflicts.add(page);
      return false;
    }
    if (base === current) {
      keep();
      return true;
    }
    if (base !== incoming) this.conflicts.add(page);
    return false;
  }
}
