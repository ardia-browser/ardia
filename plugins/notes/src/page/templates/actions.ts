import * as Y from "yjs";
import { blocksOf, childrenOf, displayTitle, getPage, updatePage } from "../../shared/model";
import { pageDocId, type PageId, type WorkspaceId } from "../../shared/protocol";
import type { CountEvent } from "../../shared/templates/counts";
import type { AppApi, PageRef } from "../app/context";

export type UseTarget = { workspace: WorkspaceId; parent?: PageId; into?: PageId };

const WAIT_MS = 4000;

export function count(app: Pick<AppApi, "client">, event: CountEvent) {
  void app.client.call("countEvent", { event }).catch(() => {});
}

export function waitForPage(tree: Y.Doc, page: PageId, ms = WAIT_MS): Promise<boolean> {
  if (getPage(tree, page)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      tree.off("update", check);
      resolve(ok);
    };
    const check = () => {
      if (getPage(tree, page)) done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    tree.on("update", check);
  });
}

export async function applyBuiltIn(app: AppApi, template: string, target: UseTarget): Promise<PageRef> {
  const { page } = await app.client.call("useTemplate", { workspace: target.workspace, template, ...(target.into ? { into: target.into } : { parent: target.parent ?? "" }) });
  const tree = app.trees.get(target.workspace);
  if (tree) await waitForPage(tree, page);
  return { workspace: target.workspace, page };
}

async function copyBlocksInto(app: AppApi, workspace: WorkspaceId, from: PageId, to: PageId) {
  const source = app.client.open(workspace, pageDocId(from));
  const target = app.client.open(workspace, pageDocId(to));
  try {
    await Promise.all([source.synced, target.synced]);
    const fragment = blocksOf(target.doc);
    const clones = blocksOf(source.doc)
      .toArray()
      .map((node) => (node as Y.XmlElement).clone());
    target.doc.transact(() => {
      if (fragment.length) fragment.delete(0, fragment.length);
      if (clones.length) fragment.insert(0, clones as Y.XmlElement[]);
    });
  } finally {
    source.release();
    setTimeout(() => target.release(), 500);
  }
}

async function copyUnder(app: AppApi, workspace: WorkspaceId, template: PageId, parent: PageId | "", title: string): Promise<PageId> {
  const tree = app.trees.get(workspace);
  const { page } = await app.client.call("duplicatePage", { workspace, page: template });
  await app.client.call("movePage", { workspace, page, parent });
  if (tree && (await waitForPage(tree, page))) updatePage(tree, page, { isTemplate: false, title }, app.me.deviceId);
  return page;
}

export async function applyYours(app: AppApi, template: PageRef, target: UseTarget): Promise<PageRef> {
  const tree = app.trees.get(template.workspace);
  const meta = tree ? getPage(tree, template.page) : null;
  if (!tree || !meta) throw new Error("That template isn't here any more.");
  const workspace = template.workspace;
  if (target.into && target.workspace === workspace) {
    await copyBlocksInto(app, workspace, template.page, target.into);
    const into = getPage(tree, target.into);
    if (into) updatePage(tree, target.into, { title: into.title || meta.title, icon: into.icon || meta.icon, cover: into.cover || meta.cover }, app.me.deviceId);
    for (const child of childrenOf(tree, template.page)) await copyUnder(app, workspace, child.id, target.into, child.title);
    return { workspace, page: target.into };
  }
  const parent = target.workspace === workspace ? (target.parent ?? "") : "";
  const page = await copyUnder(app, workspace, template.page, parent, meta.title);
  if (target.workspace !== workspace) {
    const moved = await app.client.call("movePage", { workspace, page, parent: target.parent ?? "", toWorkspace: target.workspace });
    return { workspace: moved.workspace, page: moved.page };
  }
  return { workspace, page };
}

export async function saveAsTemplate(app: AppApi, ref: PageRef, options: { asRow?: boolean } = {}): Promise<PageRef> {
  const tree = app.trees.get(ref.workspace);
  const meta = tree ? getPage(tree, ref.page) : null;
  if (!tree || !meta) throw new Error("That page isn't here any more.");
  const { page } = await app.client.call("duplicatePage", ref);
  if (!options.asRow) await app.client.call("movePage", { workspace: ref.workspace, page, parent: "" });
  if (await waitForPage(tree, page)) updatePage(tree, page, { isTemplate: true, title: displayTitle(meta) === "Untitled" ? "" : meta.title }, app.me.deviceId);
  count(app, "template_saves");
  return { workspace: ref.workspace, page };
}
