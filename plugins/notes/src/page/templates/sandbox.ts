import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { settingsOf } from "../../shared/database";
import { allPages, createPage, getPage, pagesOf, updatePage } from "../../shared/model";
import { pageDocId, treeDocId, type DocId, type PageId, type WorkspaceId } from "../../shared/protocol";
import { instantiateTemplate, type TemplateSpec } from "../../shared/templates";
import type { NotesClient, OpenDoc } from "../client/types";

export const PREVIEW_WORKSPACE = "template-preview";
const MAX_COPIED_PAGES = 120;

export type Sandbox = { tree: Y.Doc; docs: Map<PageId, Y.Doc>; root: PageId; files: WorkspaceId | null; destroy: () => void };

function emptySandbox(files: WorkspaceId | null): Omit<Sandbox, "root"> {
  const tree = new Y.Doc();
  const docs = new Map<PageId, Y.Doc>();
  return {
    tree,
    docs,
    files,
    destroy: () => {
      tree.destroy();
      for (const doc of docs.values()) doc.destroy();
    },
  };
}

export function sandboxFromTemplate(spec: TemplateSpec, me: { deviceId: string; name: string; color: string }): Sandbox {
  const box = emptySandbox(null);
  const made = instantiateTemplate(
    {
      tree: box.tree,
      by: me.deviceId,
      newDoc: (id) => {
        const doc = new Y.Doc();
        box.docs.set(id, doc);
        return doc;
      },
    },
    spec,
    { lock: true, me: { name: me.name, color: me.color } },
  );
  return { ...box, root: made.page };
}

export async function sandboxFromPage(client: NotesClient, workspace: WorkspaceId, source: Y.Doc, root: PageId, options: { withParent?: boolean } = {}): Promise<Sandbox> {
  const box = emptySandbox(workspace);
  const pages = allPages(source).filter((p) => !p.deleted);
  const ids = [root];
  for (let i = 0; i < ids.length && ids.length < MAX_COPIED_PAGES; i++) for (const p of pages) if (p.parent === ids[i] && !ids.includes(p.id)) ids.push(p.id);
  const parent = options.withParent ? getPage(source, root)?.parent || "" : "";
  if (parent) ids.unshift(parent);
  const by = client.me().deviceId;
  box.tree.transact(() => {
    for (const id of ids) {
      const meta = getPage(source, id);
      if (!meta) continue;
      createPage(box.tree, { id, parent: id === parent ? "" : id === root && !parent ? "" : meta.parent, kind: meta.kind, title: meta.title, icon: meta.icon, props: meta.props, by: meta.createdBy || by, now: meta.createdAt });
      updatePage(box.tree, id, { cover: meta.cover, coverY: meta.coverY, font: meta.font, fullWidth: meta.fullWidth, smallText: meta.smallText, locked: true, isTemplate: id === root ? false : meta.isTemplate, order: meta.order }, meta.updatedBy || by, meta.updatedAt);
    }
  });
  await Promise.all(
    ids.map(async (id) => {
      const opened = client.open(workspace, pageDocId(id));
      try {
        await opened.synced;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(opened.doc));
        if (pagesOf(box.tree).get(id)?.get("kind") === "database") settingsOf(doc).set("locked", true);
        box.docs.set(id, doc);
      } finally {
        opened.release();
      }
    }),
  );
  return { ...box, root };
}

export function previewClient(base: NotesClient, box: Sandbox): NotesClient & { dispose: () => void } {
  const awareness = new Map<Y.Doc, Awareness>();
  const docFor = (doc: DocId): Y.Doc => {
    if (doc === treeDocId) return box.tree;
    const page = doc.startsWith("p:") ? doc.slice(2) : doc;
    let found = box.docs.get(page);
    if (!found) {
      found = new Y.Doc();
      box.docs.set(page, found);
    }
    return found;
  };
  const none = () => () => {};
  return {
    ready: Promise.resolve(),
    me: () => base.me(),
    onMe: (listener) => base.onMe(listener),
    workspaces: () => base.workspaces(),
    onWorkspaces: none,
    presence: () => [],
    onPresence: none,
    open(workspace, doc): OpenDoc {
      if (workspace !== PREVIEW_WORKSPACE) return base.open(workspace, doc);
      const ydoc = docFor(doc);
      let aw = awareness.get(ydoc);
      if (!aw) {
        aw = new Awareness(ydoc);
        aw.setLocalState(null);
        awareness.set(ydoc, aw);
      }
      return { doc: ydoc, awareness: aw, synced: Promise.resolve(), release: () => {} };
    },
    call: (async (op: string) => {
      if (op === "backlinks" || op === "search") return [];
      throw new Error("This is a preview. Use the template to change it.");
    }) as NotesClient["call"],
    upload: () => Promise.reject(new Error("This is a preview.")),
    fileUrl: (_workspace, ref) => (box.files ? base.fileUrl(box.files, ref) : Promise.reject(new Error("No file"))),
    path: () => base.path(),
    onPath: none,
    navigate: () => {},
    setTitle: () => {},
    viewing: () => {},
    dispose: () => {
      for (const aw of awareness.values()) aw.destroy();
      awareness.clear();
    },
  };
}
