import * as Y from "yjs";
import { hex } from "../../shared/bytes";
import { blocksOf } from "../../shared/model";
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

function topPart(top: unknown): string {
  if (top instanceof Y.XmlElement && top.nodeName === "blockGroup") {
    const kids = top.toArray();
    while (kids.length && emptyBlock(kids[kids.length - 1])) kids.pop();
    return kids.map(canonical).join("");
  }
  return canonical(top);
}

export function bodyPrint(fragment: Y.XmlFragment): string {
  return printOf(fragment.toArray().map(topPart).join(""));
}

export const EMPTY_BODY = printOf("");

export const IMPORT_SEEDS = "importSeeds";

type Seed = { print: string; client: number; clock: number };

const itemKey = (node: unknown) => {
  const id = (node as { _item?: { id?: { client: number; clock: number } } })._item?.id;
  return id ? `${id.client}:${id.clock}` : "";
};

function randomSeedId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function writeFirstBody(doc: Y.Doc, print: string, fill: (fragment: Y.XmlFragment) => void) {
  const fragment = blocksOf(doc);
  doc.transact(() => {
    const before = fragment.length;
    fill(fragment);
    if (fragment.length !== before + 1) return;
    const group = fragment.get(0);
    const key = itemKey(group).split(":");
    if (key.length !== 2) return;
    const seed: Seed = { print, client: Number(key[0]), clock: Number(key[1]) };
    doc.getMap<Seed>(IMPORT_SEEDS).set(randomSeedId(), seed);
  });
}

export function reconcileSeeds(doc: Y.Doc): boolean {
  if (!doc.share.has(IMPORT_SEEDS)) return false;
  const seeds = doc.getMap<Seed>(IMPORT_SEEDS);
  if (seeds.size < 2) return false;
  const fragment = blocksOf(doc);
  const top = fragment.toArray();
  if (top.length < 2) return false;
  const byItem = new Map(top.map((node) => [itemKey(node), node]));
  const pristine = new Map<string, { seed: string; node: unknown }[]>();
  seeds.forEach((seed, id) => {
    const node = seed && typeof seed === "object" ? byItem.get(`${seed.client}:${seed.clock}`) : undefined;
    if (!node || printOf(topPart(node)) !== seed.print) return;
    (pristine.get(seed.print) ?? pristine.set(seed.print, []).get(seed.print)!).push({ seed: id, node });
  });
  const extra = [...pristine.values()].flatMap((copies) => copies.sort((a, b) => (a.seed < b.seed ? -1 : 1)).slice(1));
  if (!extra.length) return false;
  doc.transact(() => {
    for (const copy of extra) {
      const at = fragment.toArray().indexOf(copy.node as Y.XmlElement);
      if (at >= 0) fragment.delete(at, 1);
      seeds.delete(copy.seed);
    }
  });
  return true;
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
  private readonly born = new Set<string>();

  created(page: string) {
    this.born.add(page);
  }

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
    if (this.born.has(page)) {
      apply();
      return keep();
    }
    if (base === undefined) {
      this.conflicts.add(page);
      return keep();
    }
    if (base === cur) {
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
    if (!existed || incoming === current) {
      keep();
      return incoming !== current;
    }
    if (base === undefined) {
      keep();
      if (current === EMPTY_BODY) return true;
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
