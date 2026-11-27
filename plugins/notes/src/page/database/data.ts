import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import type { Me, PageId, PresenceEntry, WorkspaceId } from "../../shared/protocol";
import { pageDocId, treeDocId } from "../../shared/protocol";
import { getPage, pagesOf, type PageMeta } from "../../shared/model";
import {
  makeContext,
  readPeople,
  readSchema,
  readSettings,
  readViews,
  rememberPerson,
  schemaOf,
  settingsOf,
  viewsOf,
  peopleOf,
  type DatabaseSettings,
  type DbContext,
  type Person,
  type Property,
  type View,
} from "../../shared/database";
import type { NotesClient, OpenDoc } from "../client/types";

type Shared = { open: OpenDoc; refs: number; synced: boolean; listeners: Set<() => void> };
const openDocs = new WeakMap<NotesClient, Map<string, Shared>>();

function acquire(client: NotesClient, workspace: WorkspaceId, doc: string): Shared {
  let byClient = openDocs.get(client);
  if (!byClient) {
    byClient = new Map();
    openDocs.set(client, byClient);
  }
  const key = `${workspace}|${doc}`;
  let shared = byClient.get(key);
  if (!shared) {
    const open = client.open(workspace, doc);
    const created: Shared = { open, refs: 0, synced: false, listeners: new Set() };
    shared = created;
    byClient.set(key, created);
    open.synced.then(() => {
      created.synced = true;
      for (const l of [...created.listeners]) l();
    });
  }
  shared.refs++;
  return shared;
}

function release(client: NotesClient, workspace: WorkspaceId, doc: string) {
  const byClient = openDocs.get(client);
  const key = `${workspace}|${doc}`;
  const shared = byClient?.get(key);
  if (!shared) return;
  if (--shared.refs > 0) return;
  setTimeout(() => {
    if (shared.refs > 0) return;
    byClient!.delete(key);
    shared.open.release();
  }, 5000);
}

export function useDoc(client: NotesClient, workspace: WorkspaceId, doc: string | null): { doc: Y.Doc | null; synced: boolean } {
  const [state, setState] = useState<{ key: string; shared: Shared } | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!doc) {
      setState(null);
      return;
    }
    const shared = acquire(client, workspace, doc);
    setState({ key: `${workspace}|${doc}`, shared });
    const listener = () => force((n) => n + 1);
    shared.listeners.add(listener);
    return () => {
      shared.listeners.delete(listener);
      release(client, workspace, doc);
    };
  }, [client, workspace, doc]);
  const current = state && state.key === `${workspace}|${doc}` ? state.shared : null;
  return { doc: current?.open.doc ?? null, synced: current?.synced ?? false };
}

export function useDocs(client: NotesClient, workspace: WorkspaceId, ids: string[]): Map<string, Y.Doc> {
  const key = ids.slice().sort().join(",");
  const [docs, setDocs] = useState<Map<string, Y.Doc>>(new Map());
  useEffect(() => {
    const list = key ? key.split(",") : [];
    const map = new Map<string, Y.Doc>();
    for (const id of list) map.set(id, acquire(client, workspace, pageDocId(id)).open.doc);
    setDocs(map);
    return () => {
      for (const id of list) release(client, workspace, pageDocId(id));
    };
  }, [client, workspace, key]);
  return docs;
}

export function useDocVersion(doc: Y.Doc | null): number {
  const version = useRef(0);
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!doc) return () => {};
        const bump = () => {
          version.current++;
          listener();
        };
        doc.on("update", bump);
        return () => doc.off("update", bump);
      },
      [doc],
    ),
    () => (doc ? version.current : -1),
  );
}

export function useDocsVersion(docs: Map<string, Y.Doc>): number {
  const version = useRef(0);
  const list = useMemo(() => [...docs.values()], [docs]);
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const bump = () => {
          version.current++;
          listener();
        };
        for (const d of list) d.on("update", bump);
        return () => {
          for (const d of list) d.off("update", bump);
        };
      },
      [list],
    ),
    () => version.current,
  );
}

class RowStore {
  pages = new Map<string, PageMeta>();
  byParent = new Map<string, PageMeta[] | null>();
  version = 0;
  listeners = new Set<() => void>();
  constructor(readonly tree: Y.Doc) {
    pagesOf(tree).forEach((_entry, id) => {
      const page = getPage(tree, id);
      if (page) this.pages.set(id, page);
    });
    pagesOf(tree).observeDeep((events) => {
      const changed = new Set<string>();
      for (const event of events) {
        if (event.target === pagesOf(tree)) for (const key of (event as Y.YMapEvent<unknown>).keysChanged) changed.add(key);
        else {
          const first = event.path[0];
          if (typeof first === "string") changed.add(first);
        }
      }
      for (const id of changed) {
        const old = this.pages.get(id);
        const page = getPage(tree, id);
        if (page) this.pages.set(id, page);
        else this.pages.delete(id);
        if (old) this.byParent.set(old.parent, null);
        if (page) this.byParent.set(page.parent, null);
      }
      if (!changed.size) return;
      this.version++;
      for (const l of [...this.listeners]) l();
    });
  }
  children(parent: string): PageMeta[] {
    const hit = this.byParent.get(parent);
    if (hit) return hit;
    const out: PageMeta[] = [];
    for (const page of this.pages.values()) if (page.parent === parent && !page.deleted && page.archivedAt === 0 && page.kind === "page") out.push(page);
    out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
    this.byParent.set(parent, out);
    return out;
  }
}

const stores = new WeakMap<Y.Doc, RowStore>();
export function rowStore(tree: Y.Doc): RowStore {
  let store = stores.get(tree);
  if (!store) {
    store = new RowStore(tree);
    stores.set(tree, store);
  }
  return store;
}

export function useRowStore(tree: Y.Doc | null): { store: RowStore | null; version: number } {
  const store = tree ? rowStore(tree) : null;
  const version = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!store) return () => {};
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      [store],
    ),
    () => (store ? store.version : -1),
  );
  return { store, version };
}

export function useMe(client: NotesClient): Me {
  return useSyncExternalStore(
    useCallback((l: () => void) => client.onMe(l), [client]),
    () => client.me(),
  );
}

export function usePresence(client: NotesClient): PresenceEntry[] {
  const [list, setList] = useState<PresenceEntry[]>(() => client.presence());
  useEffect(() => client.onPresence(setList), [client]);
  return list;
}

export type DatabaseModel = {
  client: NotesClient;
  workspace: WorkspaceId;
  page: PageId;
  source: PageId;
  tree: Y.Doc;
  doc: Y.Doc;
  schemaDoc: Y.Doc;
  meta: PageMeta | null;
  sourceMeta: PageMeta | null;
  schema: Property[];
  views: View[];
  settings: DatabaseSettings;
  rows: PageMeta[];
  templates: PageMeta[];
  people: Map<string, Person>;
  me: Me;
  ctx: DbContext;
  locked: boolean;
  synced: boolean;
  rowVersion: number;
  schemaVersion: number;
  docFor: (database: PageId) => Y.Doc | null;
  store: { pages: Map<string, PageMeta>; children: (parent: string) => PageMeta[] };
};

const emptyDoc = new Y.Doc();

export function useDatabase(client: NotesClient, workspace: WorkspaceId, page: PageId): DatabaseModel | null {
  const tree = useDoc(client, workspace, treeDocId);
  const own = useDoc(client, workspace, page ? pageDocId(page) : null);
  const ownVersion = useDocVersion(own.doc);
  const sourceId = useMemo(() => (own.doc ? readSettings(own.doc).source : ""), [own.doc, ownVersion]);
  const source = useDoc(client, workspace, sourceId ? pageDocId(sourceId) : null);
  const sourceVersion = useDocVersion(source.doc);
  const schemaDoc = sourceId ? source.doc : own.doc;
  const schemaVersion = sourceId ? sourceVersion : ownVersion;
  const schema = useMemo(() => (schemaDoc ? readSchema(schemaDoc) : []), [schemaDoc, schemaVersion]);
  const relatedIds = useMemo(() => [...new Set(schema.filter((p) => p.type === "relation" && p.relation && p.relation !== (sourceId || page)).map((p) => p.relation))], [schema, sourceId, page]);
  const related = useDocs(client, workspace, relatedIds);
  const relatedVersion = useDocsVersion(related);
  const { store, version: rowVersion } = useRowStore(tree.doc);
  const me = useMe(client);
  const presence = usePresence(client);
  const dbId = sourceId || page;

  useEffect(() => {
    if (!schemaDoc || !(sourceId ? source.synced : own.synced)) return;
    rememberPerson(schemaDoc, { id: me.deviceId, name: me.name, color: me.color });
  }, [schemaDoc, me.deviceId, me.name, me.color, own.synced, source.synced, sourceId]);

  const views = useMemo(() => (own.doc ? readViews(own.doc) : []), [own.doc, ownVersion]);
  const settings = useMemo(() => (own.doc ? readSettings(own.doc) : readSettings(emptyDoc)), [own.doc, ownVersion]);
  const sourceSettings = useMemo(() => (source.doc ? readSettings(source.doc) : null), [source.doc, sourceVersion]);
  const people = useMemo(() => {
    const map = new Map<string, Person>();
    if (schemaDoc) for (const p of readPeople(schemaDoc)) map.set(p.id, p);
    for (const entry of presence) if (entry.workspace === workspace) map.set(entry.deviceId, { id: entry.deviceId, name: entry.name, color: entry.color });
    map.set(me.deviceId, { id: me.deviceId, name: me.name, color: me.color });
    return map;
  }, [schemaDoc, schemaVersion, presence, me, workspace]);

  const rows = useMemo(() => (store ? store.children(dbId).filter((p) => !p.isTemplate) : []), [store, rowVersion, dbId]);
  const templates = useMemo(() => (store ? store.children(dbId).filter((p) => p.isTemplate) : []), [store, rowVersion, dbId]);

  const ctx = useMemo(() => {
    const schemas = new Map<string, Property[]>();
    if (schemaDoc) schemas.set(dbId, schema);
    for (const [id, d] of related) schemas.set(id, readSchema(d));
    return makeContext({
      database: dbId,
      schema,
      rows,
      page: (id) => store?.pages.get(id) ?? null,
      schemaFor: (id) => schemas.get(id) ?? null,
      rowsFor: (id) => (store ? store.children(id).filter((p) => !p.isTemplate) : []),
      people,
    });
  }, [schema, rows, store, related, relatedVersion, people, dbId, schemaDoc]);

  if (!tree.doc || !own.doc || !schemaDoc || !store) return null;
  return {
    client,
    workspace,
    page,
    source: dbId,
    tree: tree.doc,
    doc: own.doc,
    schemaDoc,
    meta: store.pages.get(page) ?? null,
    sourceMeta: store.pages.get(dbId) ?? null,
    schema,
    views,
    settings,
    rows,
    templates,
    people,
    me,
    ctx,
    locked: settings.locked || sourceSettings?.locked === true,
    synced: own.synced && tree.synced && (!sourceId || source.synced),
    rowVersion,
    schemaVersion,
    docFor: (id) => (id === dbId ? schemaDoc : related.get(id) ?? null),
    store,
  };
}

export function useRelatedDoc(client: NotesClient, workspace: WorkspaceId, database: PageId | null) {
  return useDoc(client, workspace, database ? pageDocId(database) : null);
}

export function databasesIn(store: { pages: Map<string, PageMeta> }): PageMeta[] {
  const out: PageMeta[] = [];
  for (const p of store.pages.values()) if (p.kind === "database" && !p.deleted && p.archivedAt === 0) out.push(p);
  return out.sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled"));
}

export { schemaOf, settingsOf, viewsOf, peopleOf };
