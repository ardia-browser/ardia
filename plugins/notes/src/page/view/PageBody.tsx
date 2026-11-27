import { useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { getPage, isArchivedDeep, updatePage, type PageMeta } from "../../shared/model";
import { pageDocId, type PageId, type WorkspaceId } from "../../shared/protocol";
import { useApp } from "../app/context";
import { usePageMeta } from "../app/hooks";
import { PageComments } from "../comments/Comments";
import { DatabaseHost, DatabasePage, RowProperties, type DatabaseHostValue } from "../database";
import type { NotesEnv } from "../editor/env";
import { NoteEditor, type EditorHandle } from "../editor/NoteEditor";
import { selectBlocks } from "../editor/ops";
import { flashElement } from "../ui/flash";
import { Cover, HeaderControls, PageIconButton, PageTitle } from "./PageHeader";
import { Backlinks } from "./Backlinks";


export type OpenedPage = { doc: Y.Doc; awareness: Awareness };

export function useOpenedDoc(workspace: WorkspaceId, page: PageId): OpenedPage | null {
  const app = useApp();
  const [opened, setOpened] = useState<OpenedPage | null>(null);
  useEffect(() => {
    const handle = app.client.open(workspace, pageDocId(page));
    let live = true;
    void handle.synced.then(() => live && setOpened({ doc: handle.doc, awareness: handle.awareness }));
    return () => {
      live = false;
      handle.release();
      setOpened(null);
    };
  }, [app.client, workspace, page]);
  return opened;
}

export function usePageEnv(workspace: WorkspaceId, page: PageId, readOnly: boolean): NotesEnv {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  const tree = app.trees.get(workspace)!;
  return useMemo(
    () => ({
      client: app.client,
      workspace,
      page,
      tree,
      trees: app.trees,
      readOnly,
      openPage: (target, options) => latest.current.openPage(target, { workspace: options?.workspace ?? workspace, block: options?.block, newTab: options?.newTab }),
      createChildPage: async (options) => {
        const ref = await latest.current.newPage({ workspace, parent: page, kind: options?.kind, title: options?.title, props: options?.props, open: false });
        return ref?.page ?? "";
      },
      openUrl: (url) => void latest.current.client.call("openUrl", { url }),
    }),
    [app.client, workspace, page, tree, app.trees, readOnly],
  );
}

export function useDatabaseHost(workspace: WorkspaceId): DatabaseHostValue {
  const app = useApp();
  return useMemo(
    () => ({
      client: app.client,
      workspace,
      onOpenRow: (row: PageId, mode: "peek" | "full") => {
        if (mode === "full") app.openPage(row, { workspace });
      },
      renderBody: (row: PageMeta) => <RowBody key={row.id} workspace={workspace} page={row.id} />,
    }),
    [app.client, workspace, app.openPage],
  );
}

export function RowBody({ workspace, page }: { workspace: WorkspaceId; page: PageId }) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  const meta = usePageMeta(tree, page);
  const opened = useOpenedDoc(workspace, page);
  const readOnly = !!meta && (meta.locked || isArchivedDeep(tree, page));
  const env = usePageEnv(workspace, page, readOnly);
  if (!opened) return <div className="n-editor-loading" aria-busy="true" />;
  return (
    <div className={`n-page n-row-body font-${meta?.font ?? "default"}`} data-testid="row-body">
      <NoteEditor key={page} env={env} doc={opened.doc} awareness={opened.awareness} me={app.me} presence={app.presence} readOnly={readOnly} onReady={() => {}} onOpenThread={() => {}} />
    </div>
  );
}

export function PageBody({
  workspace,
  page,
  onHandle,
  onThread,
  embedded,
  composingComment,
  setComposingComment,
}: {
  workspace: WorkspaceId;
  page: PageId;
  onHandle?: (handle: EditorHandle | null) => void;
  onThread?: (id: string) => void;
  embedded?: boolean;
  composingComment: boolean;
  setComposingComment: (on: boolean) => void;
}) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  const meta = usePageMeta(tree, page);
  const opened = useOpenedDoc(workspace, page);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const archived = isArchivedDeep(tree, page);
  const readOnly = !!meta && (meta.locked || archived);
  const parent = meta?.parent ? getPage(tree, meta.parent) : null;
  const lastBump = useRef(0);

  const env = usePageEnv(workspace, page, readOnly);
  const host = useDatabaseHost(workspace);

  useEffect(() => {
    if (!opened) return;
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      const local = !!origin && typeof origin === "object" && "key" in origin && String((origin as { key: unknown }).key).startsWith("y-sync");
      if (!local) return;
      const now = Date.now();
      if (now - lastBump.current < 4000) return;
      lastBump.current = now;
      updatePage(tree, page, {}, app.me.deviceId);
    };
    opened.doc.on("update", onUpdate);
    return () => opened.doc.off("update", onUpdate);
  }, [opened, tree, page]);

  useEffect(() => {
    onHandle?.(handle);
  }, [handle]);

  useEffect(() => {
    if (!handle || app.route.kind !== "page" || app.route.page !== page || !app.route.block || embedded) return;
    const id = app.route.block;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      const el = document.querySelector(`.n-editor .bn-block-outer[data-id="${id}"]`);
      if (!el) {
        if (tries++ < 40) timer = setTimeout(attempt, 100);
        return;
      }
      selectBlocks(handle.editor, [id]);
      flashElement(el, 2400);
    };
    timer = setTimeout(attempt, 120);
    return () => clearTimeout(timer);
  }, [handle, app.route.kind === "page" ? app.route.block : null]);

  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (handle && pendingFocus.current !== null) {
      const rest = pendingFocus.current;
      pendingFocus.current = null;
      focusBody(rest);
    }
  }, [handle]);

  if (!meta) return null;
  const by = app.me.deviceId;
  function focusBody(rest: string) {
    const editor = handle?.editor;
    if (readOnly) return;
    if (!editor) {
      pendingFocus.current = rest;
      return;
    }
    const first = editor.document[0] as { id: string; type: string; content?: unknown[] } | undefined;
    if (rest || !first || first.type !== "paragraph" || first.content?.length) {
      const [inserted] = editor.insertBlocks([{ type: "paragraph", content: rest }] as never, first?.id ?? editor.document[0]!.id, "before");
      if (inserted) editor.setTextCursorPosition(inserted, "start");
    } else editor.setTextCursorPosition(first, "start");
    editor.focus();
  }
  function focusFirst() {
    const editor = handle?.editor;
    const first = editor?.document[0] as { id: string; type: string } | undefined;
    if (!editor || !first) return;
    if (first.type === "paragraph" || first.type === "heading" || first.type.endsWith("ListItem") || first.type === "quote" || first.type === "callout") editor.setTextCursorPosition(first.id, "start");
    else selectBlocks(editor, [first.id]);
    editor.focus();
  }

  return (
    <DatabaseHost value={host}>
    <article className={`n-page font-${meta.font}${meta.fullWidth ? " is-full" : ""}${meta.smallText ? " is-small" : ""}${meta.cover ? " has-cover" : ""}${meta.icon ? " has-icon" : ""}`} data-testid="page" data-page-id={page}>
      <Cover meta={meta} tree={tree} client={app.client} workspace={workspace} readOnly={readOnly} by={by} />
      {meta.kind !== "database" ? (
      <div className="n-page-column">
        <header className="n-page-header">
          <PageIconButton meta={meta} tree={tree} client={app.client} workspace={workspace} readOnly={readOnly} by={by} hasCover={!!meta.cover} />
          <HeaderControls meta={meta} tree={tree} by={by} readOnly={readOnly} onComment={() => setComposingComment(true)} />
          <PageTitle meta={meta} tree={tree} by={by} readOnly={readOnly} onEnter={focusBody} onArrowDown={focusFirst} />
          {parent?.kind === "database" ? (
            <div className="n-row-props">
              <RowProperties client={app.client} workspace={workspace} database={parent.id} row={page} />
            </div>
          ) : null}
          <Backlinks workspace={workspace} page={page} />
          {handle ? <PageComments store={handle.threadStore} me={app.me} composing={composingComment} onDone={() => setComposingComment(false)} /> : null}
        </header>
      </div>
      ) : null}
      {meta.kind === "database" ? (
        <div className="n-database-host">
          <DatabasePage
            client={app.client}
            workspace={workspace}
            page={page}
            view={app.route.kind === "page" && app.route.page === page ? app.route.view : null}
            inline={false}
            onView={(view) => app.openPage(page, { workspace, view, replace: true })}
            onOpenRow={(row, mode) => (mode === "peek" ? app.openPage(page, { workspace, peek: row, view: app.route.kind === "page" ? app.route.view : null }) : app.openPage(row, { workspace }))}
            peek={app.route.kind === "page" && app.route.page === page ? app.route.peek : null}
            onClosePeek={() => app.openPage(page, { workspace, view: app.route.kind === "page" ? app.route.view : null, replace: true })}
            renderBody={(row) => <RowBody key={row.id} workspace={workspace} page={row.id} />}
          />
        </div>
      ) : (
        <div className="n-page-column n-editor-column">
          {opened ? (
            <NoteEditor
              key={page}
              env={env}
              doc={opened.doc}
              awareness={opened.awareness}
              me={app.me}
              presence={app.presence}
              readOnly={readOnly}
              onReady={setHandle}
              onOpenThread={(id) => onThread?.(id)}
            />
          ) : (
            <div className="n-editor-loading" aria-busy="true" />
          )}
        </div>
      )}
    </article>
    </DatabaseHost>
  );
}
