import { useCallback, useEffect, useRef, useState } from "react";
import { displayTitle, isArchivedDeep, pagePath } from "../../shared/model";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { useApp } from "../app/context";
import { usePageMeta } from "../app/hooks";
import { CommentsPanel } from "../comments/Comments";
import { CommentsExtension } from "@blocknote/core/comments";
import type { EditorHandle } from "../editor/NoteEditor";
import { HistorySheet } from "./HistorySheet";
import { installMarquee } from "../editor/marquee";
import { PageBody } from "./PageBody";
import { Topbar } from "./Topbar";
import { ghostOut, MOTION, useClosingFocus, usePresence } from "../ui/motion";

const PAGE_PRUNE = ".bn-block-group > .bn-block-outer, .db-card, .db-tr, .db-gallery-card, .db-list-row";

export function PageView({ workspace, page }: { workspace: WorkspaceId; page: PageId }) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  const meta = usePageMeta(tree, page);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [panel, setPanel] = useState<"comments" | null>(null);
  const [history, setHistory] = useState(false);
  const [selectedThread, setSelectedThread] = useState<string | undefined>();
  const [composing, setComposing] = useState(false);
  const archived = isArchivedDeep(tree, page);
  const comments = usePresence(panel === "comments", MOTION.base);
  const banner = usePresence(archived, MOTION.base);
  const bannerRef = useClosingFocus<HTMLDivElement>(banner.closing);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollerCallback = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    if (!el) return undefined;
    return () => ghostOut(el, "is-page-leaving", MOTION.exit, { force: true, prune: PAGE_PRUNE });
  }, []);
  useEffect(() => {
    if (!handle || !scrollerRef.current) return;
    return installMarquee(handle.editor, scrollerRef.current);
  }, [handle]);

  useEffect(() => {
    if (meta) app.client.setTitle(`${meta.icon && !meta.icon.startsWith("file:") ? `${meta.icon} ` : ""}${displayTitle(meta)}`);
  }, [meta?.icon, meta?.title]);

  const shownPath = app.client.path();
  useEffect(() => {
    if (!meta || app.route.kind !== "page" || app.route.page !== page) return;
    const timer = setTimeout(() => {
      const current = app.client.path();
      const [pathname, query] = current.split("?");
      const wanted = pagePath(meta);
      if (pathname !== wanted) app.navigate(`${wanted}${query ? `?${query}` : ""}`, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [meta?.title, shownPath]);

  if (!meta) return null;
  const ref = { workspace, page };
  return (
    <div className="n-main-col is-entering">
      <Topbar workspace={workspace} page={page} handle={handle} commentsOpen={panel === "comments"} onToggleComments={() => setPanel((p) => (p === "comments" ? null : "comments"))} onHistory={() => setHistory(true)} />
      {banner.mounted ? (
        <div ref={bannerRef} inert={banner.closing} aria-hidden={banner.closing || undefined} className={`n-trash-banner${banner.closing ? " is-closing" : ""}`} role="alert" data-testid={banner.closing ? undefined : "trash-banner"}>
          <span>This page is in Trash.</span>
          <button type="button" className="n-banner-button" data-testid="banner-restore" onClick={() => void app.restore(ref)}>
            Restore page
          </button>
          <button
            type="button"
            className="n-banner-button"
            data-testid="banner-delete"
            onClick={() => {
              void app.deleteForever(ref).then(() => app.navigate("/home", { replace: true }));
            }}
          >
            Delete from Trash
          </button>
        </div>
      ) : null}
      <div className="n-page-row">
        <div
          className="n-scroller"
          data-testid="page-scroller"
          ref={scrollerCallback}
        >
          <PageBody
            workspace={workspace}
            page={page}
            onHandle={setHandle}
            composingComment={composing}
            setComposingComment={setComposing}
            onThread={(id) => {
              setSelectedThread(id);
              setPanel("comments");
            }}
          />
          <div className="n-page-tail" onClick={() => handle && !meta.locked && !archived && focusEnd(handle)} />
        </div>
        {comments.mounted && handle ? (
          <CommentsPanel
            closing={comments.closing}
            store={handle.threadStore}
            me={app.me}
            selected={selectedThread}
            onSelect={(thread) => {
              setSelectedThread(thread.id);
              handle.editor.getExtension(CommentsExtension)?.selectThread(thread.id, true);
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </div>
      {history ? <HistorySheet workspace={workspace} page={page} onClose={() => setHistory(false)} /> : null}
    </div>
  );
}

function focusEnd(handle: EditorHandle) {
  const editor = handle.editor;
  const last = editor.document.at(-1) as { id: string; type: string; content?: unknown[] } | undefined;
  if (!last) return;
  if (last.type === "paragraph" && !last.content?.length) editor.setTextCursorPosition(last, "end");
  else {
    const [block] = editor.insertBlocks([{ type: "paragraph" }] as never, last.id, "after");
    if (block) editor.setTextCursorPosition(block, "start");
  }
  editor.focus();
}
