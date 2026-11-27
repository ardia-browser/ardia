import * as Y from "yjs";
import { schemaOf, settingsOf, TITLE, viewMapOf, viewsOf } from "../../shared/database";
import { pagesOf } from "../../shared/model";
import type { Rebase } from "./rebase";

function cloneY(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const out = new Y.Map<unknown>();
    value.forEach((v, k) => out.set(k, cloneY(v)));
    return out;
  }
  if (value instanceof Y.Array) {
    const out = new Y.Array<unknown>();
    out.push(value.toArray().map(cloneY));
    return out;
  }
  return value;
}

const plain = (value: unknown) => (value instanceof Y.AbstractType ? value.toJSON() : (value ?? null));

const nameOf = (entry: unknown) => (entry instanceof Y.Map ? String(entry.get("name") ?? "").trim().toLowerCase() : "");

function legacyView(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  let found: Y.Map<unknown> | undefined;
  viewsOf(doc).forEach((entry) => {
    if (!found && entry instanceof Y.Map && entry.get("id") === id) found = entry;
  });
  return found;
}

function dropLegacyView(doc: Y.Doc, id: string) {
  const array = viewsOf(doc);
  for (let i = array.length - 1; i >= 0; i--) {
    const entry = array.get(i);
    if (entry instanceof Y.Map && entry.get("id") === id) array.delete(i, 1);
  }
}

function viewIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>(viewMapOf(doc).keys());
  viewsOf(doc).forEach((entry) => {
    if (entry instanceof Y.Map && typeof entry.get("id") === "string") ids.add(String(entry.get("id")));
  });
  return ids;
}

function adoptSameNamedColumns(target: Y.Doc, scratch: Y.Doc, tree: Y.Doc, page: string, entry: Y.Map<unknown>, rebase: Rebase) {
  const incoming = schemaOf(scratch);
  const mine = schemaOf(target);
  const free = new Map<string, string>();
  mine.forEach((col, id) => {
    if (id === TITLE || incoming.has(id) || rebase.knows(entry, `col:${id}`) || (col instanceof Y.Map && col.get("deleted") === true)) return;
    const name = nameOf(col);
    if (name && !free.has(name)) free.set(name, id);
  });
  if (!free.size) return;
  const rows = [...pagesOf(tree).entries()].filter(([, e]) => e instanceof Y.Map && e.get("parent") === page && e.get("deleted") !== true);
  incoming.forEach((col, id) => {
    if (mine.has(id) || rebase.knows(entry, `col:${id}`)) return;
    const old = free.get(nameOf(col));
    if (!old) return;
    free.delete(nameOf(col));
    for (const [, row] of rows) {
      const props = row.get("props");
      if (!(props instanceof Y.Map) || !props.has(old)) continue;
      tree.transact(() => {
        if (!props.has(id)) props.set(id, props.get(old));
        props.delete(old);
      });
    }
    mine.set(id, cloneY(mine.get(old)) as Y.Map<unknown>);
    mine.delete(old);
  });
}

export function mergeDatabase(target: Y.Doc, scratch: Y.Doc, tree: Y.Doc, page: string, rebase: Rebase) {
  const entry = pagesOf(tree).get(page);
  if (!entry) return;
  const merge = (key: string, current: unknown, incoming: unknown, apply: () => void) => tree.transact(() => rebase.field(page, entry, key, plain(current), plain(incoming), () => target.transact(apply)));
  target.transact(() => adoptSameNamedColumns(target, scratch, tree, page, entry, rebase));
  const mine = schemaOf(target);
  const theirs = schemaOf(scratch);
  theirs.forEach((col, id) => merge(`col:${id}`, mine.get(id), col, () => mine.set(id, cloneY(col) as Y.Map<unknown>)));
  for (const id of [...mine.keys()]) if (!theirs.has(id) && rebase.knows(entry, `col:${id}`)) merge(`col:${id}`, mine.get(id), null, () => mine.delete(id));
  const incomingViews = viewIds(scratch);
  const currentView = (doc: Y.Doc, id: string) => viewMapOf(doc).get(id) ?? legacyView(doc, id);
  for (const id of incomingViews)
    merge(`view:${id}`, currentView(target, id), currentView(scratch, id), () => {
      dropLegacyView(target, id);
      viewMapOf(target).set(id, cloneY(currentView(scratch, id)) as Y.Map<unknown>);
    });
  for (const id of viewIds(target))
    if (!incomingViews.has(id) && rebase.knows(entry, `view:${id}`))
      merge(`view:${id}`, currentView(target, id), null, () => {
        dropLegacyView(target, id);
        viewMapOf(target).delete(id);
      });
  const settings = settingsOf(target);
  const incomingSettings = settingsOf(scratch);
  incomingSettings.forEach((value, key) => merge(`set:${key}`, settings.get(key), value, () => settings.set(key, cloneY(value))));
  for (const key of [...settings.keys()]) if (!incomingSettings.has(key) && rebase.knows(entry, `set:${key}`)) merge(`set:${key}`, settings.get(key), null, () => settings.delete(key));
}
