import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import type { SavedObject } from "../../lib/savedDocument";
import { savedPage } from "./savedShapes";
import { SESSION_DOCUMENT } from "./sessionDocument";

type Key = keyof BrowserState;
type Field<K extends Key, V> = { reads: readonly K[]; save: (s: Pick<BrowserState, K>) => V };
export const field = <K extends Key, V>(reads: readonly K[], save: (s: Pick<BrowserState, K>) => V): Field<K, V> => ({ reads, save });

const LISTED = Symbol("listed");
type Listed<T extends object> = { [LISTED]: true; items: readonly T[]; shape: (item: T) => unknown };
export const listed = <T extends object>(items: readonly T[], shape: (item: T) => unknown = (item) => item): Listed<T> => ({ [LISTED]: true, items, shape });
const isListed = (value: unknown): value is Listed<object> => typeof value === "object" && value !== null && LISTED in value;

export type Doc = { name: string; reads: readonly Key[]; json: (s: BrowserState) => string; value: (s: BrowserState) => SavedObject };

const documents = new Map<string, Doc>();

export function doc<F extends Record<string, Field<Key, unknown>>>(name: string, version: number, fields: F): Doc {
  const entries = Object.entries(fields);
  const fragments = new Map(entries.map(([key]) => [key, new WeakMap<object, string>()]));
  const valueJson = (key: string, value: unknown): string | undefined => {
    if (!isListed(value)) return JSON.stringify(value);
    const cache = fragments.get(key)!;
    const parts = value.items.map((item) => {
      let json = cache.get(item);
      if (json === undefined) {
        json = JSON.stringify(value.shape(item)) ?? "null";
        cache.set(item, json);
      }
      return json;
    });
    return `[${parts.join(",")}]`;
  };
  const built: Doc = {
    name,
    reads: [...new Set(entries.flatMap(([, f]) => f.reads))],
    json: (s) => objectJson([...entries.map(([key, f]): [string, string | undefined] => [key, valueJson(key, f.save(s))]), ["version", JSON.stringify(version)]]),
    value: (s) =>
      Object.fromEntries(
        entries.map(([key, f]) => {
          const value = f.save(s);
          return [key, isListed(value) ? value.items.map(value.shape) : value];
        }),
      ),
  };
  documents.set(name, built);
  return built;
}

export const savedDocumentJson = (name: string, s: BrowserState) => documents.get(name)!.json(s);
export const savedDocumentValue = (name: string, s: BrowserState) => documents.get(name)!.value(s);

const objectJson = (members: readonly [string, string | undefined][]) =>
  `{${members.flatMap(([key, json]) => (json === undefined ? [] : [`${JSON.stringify(key)}:${json}`])).join(",")}}`;

const COSMETIC_TAB_FIELDS: ReadonlySet<string> = new Set(["title", "favicon", "lastActiveAt", "unseen"]);

const samePage = (a: Tab, b: Tab) => {
  const was = savedPage(a);
  const now = savedPage(b);
  return was.kind === now.kind && was.wake === now.wake;
};

const TABS_READ = "tabs" satisfies Key;

export function cosmeticChange(doc: Doc, before: readonly unknown[], after: readonly unknown[]): boolean {
  if (doc.name !== SESSION_DOCUMENT) return false;
  const tabs = doc.reads.indexOf(TABS_READ);
  if (tabs < 0 || before[tabs] === after[tabs]) return false;
  if (!after.every((v, i) => i === tabs || v === before[i])) return false;
  return cosmeticTabsChange(before[tabs] as Record<string, Tab>, after[tabs] as Record<string, Tab>);
}

function onlyCosmetic(a: Tab, b: Tab): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (COSMETIC_TAB_FIELDS.has(key)) continue;
    if (key === "page" ? !samePage(a, b) : a[key as keyof Tab] !== b[key as keyof Tab]) return false;
  }
  return true;
}

export function cosmeticTabsChange(before: Record<string, Tab>, after: Record<string, Tab>): boolean {
  const was = Object.keys(before);
  const now = Object.keys(after);
  if (was.length !== now.length) return false;
  for (let i = 0; i < now.length; i++) {
    const id = now[i]!;
    if (was[i] !== id) return false;
    const a = before[id]!;
    const b = after[id]!;
    if (a !== b && !onlyCosmetic(a, b)) return false;
  }
  return true;
}
