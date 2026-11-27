import * as Y from "yjs";

type Kind = "xml" | "map" | "array" | "text";

const KNOWN: Record<string, Kind> = { blocks: "xml", comments: "map", schema: "map", views: "array" };

function kindOf(doc: Y.Doc, name: string): Kind | null {
  const t = doc.share.get(name);
  if (t instanceof Y.XmlFragment) return "xml";
  if (t instanceof Y.Map) return "map";
  if (t instanceof Y.Array) return "array";
  if (t instanceof Y.Text) return "text";
  return null;
}

const cloneValue = (v: unknown): unknown => (v instanceof Y.AbstractType ? (v as Y.AbstractType<unknown> & { clone(): unknown }).clone() : v);

export function replaceContent(target: Y.Doc, source: Y.Doc, origin: unknown = null) {
  const names = new Set<string>([...Object.keys(KNOWN), ...target.share.keys(), ...source.share.keys()]);
  target.transact(() => {
    for (const name of names) {
      const kind = kindOf(target, name) ?? kindOf(source, name) ?? KNOWN[name] ?? null;
      if (!kind) continue;
      if (kind === "xml") {
        const t = target.getXmlFragment(name);
        const s = source.getXmlFragment(name);
        if (t.length) t.delete(0, t.length);
        const items = s.toArray().map((n) => cloneValue(n) as Y.XmlElement | Y.XmlText);
        if (items.length) t.insert(0, items);
      } else if (kind === "map") {
        const t = target.getMap<unknown>(name);
        const s = source.getMap<unknown>(name);
        for (const key of [...t.keys()]) if (!s.has(key)) t.delete(key);
        s.forEach((value, key) => t.set(key, cloneValue(value)));
      } else if (kind === "array") {
        const t = target.getArray<unknown>(name);
        const s = source.getArray<unknown>(name);
        if (t.length) t.delete(0, t.length);
        const items = s.toArray().map(cloneValue);
        if (items.length) t.insert(0, items);
      } else {
        const t = target.getText(name);
        const s = source.getText(name);
        if (t.length) t.delete(0, t.length);
        t.applyDelta(s.toDelta());
      }
    }
  }, origin);
}

export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  return doc;
}

export function isEmptyDoc(doc: Y.Doc): boolean {
  for (const t of doc.share.values()) {
    if (t instanceof Y.XmlFragment || t instanceof Y.Array || t instanceof Y.Text) {
      if (t.length > 0) return false;
    } else if (t instanceof Y.Map) {
      if (t.size > 0) return false;
    } else if (t._start || t._map.size > 0) return false;
  }
  return true;
}

export function remapPageRefs(fragment: Y.XmlFragment | Y.XmlElement, remap: Map<string, string>) {
  if (remap.size === 0) return;
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const attrs = child.getAttributes() as Record<string, unknown>;
    for (const [name, value] of Object.entries(attrs)) {
      if (typeof value === "string" && remap.has(value)) child.setAttribute(name, remap.get(value)!);
    }
    remapPageRefs(child, remap);
  }
}

const PAGE_ID = /^[0-9a-f]{12}$/;
const LINKS = new Set(["mention", "linkToPage"]);

export function linkedPages(fragment: Y.XmlFragment | Y.XmlElement, out = new Set<string>()): Set<string> {
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (LINKS.has(child.nodeName)) {
      const id = child.getAttribute("pageId");
      const kind = child.getAttribute("kind");
      if (typeof id === "string" && PAGE_ID.test(id) && (kind === undefined || kind === null || kind === "page")) out.add(id);
    }
    linkedPages(child, out);
  }
  return out;
}

const VISIBLE: Record<string, Kind> = { ...KNOWN, settings: "map", people: "map" };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  return value;
}

export function visibleContent(doc: Y.Doc): string {
  const out: Record<string, unknown> = {};
  const names = new Set<string>([...Object.keys(VISIBLE), ...doc.share.keys()]);
  for (const name of [...names].sort()) {
    const kind = kindOf(doc, name) ?? VISIBLE[name] ?? null;
    if (kind === "xml") out[name] = doc.getXmlFragment(name).toString();
    else if (kind === "map") out[name] = stable(doc.getMap(name).toJSON());
    else if (kind === "array") out[name] = stable(doc.getArray(name).toJSON());
    else if (kind === "text") out[name] = doc.getText(name).toString();
  }
  return JSON.stringify(out);
}
