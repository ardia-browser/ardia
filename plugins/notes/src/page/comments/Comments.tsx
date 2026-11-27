import type { ThreadData, ThreadStore } from "@blocknote/core/comments";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Me } from "../../shared/protocol";
import { relativeTime, useNow } from "../app/hooks";
import { Icon } from "../ui/icons";
import { MOTION, useClosingFocus, useFlip, useLeaveRef } from "../ui/motion";

export type CommentMeta = { name: string; color: string };

export function commentText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!Array.isArray(body)) return "";
  return body
    .map((block: { content?: unknown }) => {
      const content = block?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text ?? "").join("");
      return "";
    })
    .join("\n");
}

export const commentBody = (text: string) => text.split("\n").map((line) => ({ type: "paragraph", content: line }));

const emptyThreads = new Map<string, ThreadData>();

export function useThreadMap(store: ThreadStore | null): Map<string, ThreadData> {
  const cache = useRef<Map<string, ThreadData>>(emptyThreads);
  return useSyncExternalStore(
    (listener) => {
      if (!store) return () => {};
      return store.subscribe((threads) => {
        cache.current = new Map(threads);
        listener();
      });
    },
    () => {
      if (store && cache.current === emptyThreads) cache.current = new Map(store.getThreads());
      return cache.current;
    },
  );
}

export function Avatar({ name, color, size = 22 }: { name: string; color: string; size?: number }) {
  return (
    <span className="n-avatar" style={{ background: color || "var(--n-accent)", width: size, height: size, fontSize: Math.round(size * 0.48) }} title={name}>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function Composer({ me, placeholder, onSubmit, autoFocus, onCancel, compact }: { me: Me; placeholder: string; onSubmit: (text: string) => void; autoFocus?: boolean; onCancel?: () => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText("");
  };
  return (
    <div className={`n-composer${compact ? " is-compact" : ""}`} data-testid="comment-composer">
      <Avatar name={me.name || "You"} color={me.color} size={compact ? 20 : 24} />
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className="n-send" disabled={!text.trim()} aria-label="Send comment" onClick={submit}>
        <Icon name="arrowRight" size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function ThreadView({ thread, store, me, onSelect, active, showQuote = true }: { thread: ThreadData; store: ThreadStore; me: Me; onSelect?: () => void; active?: boolean; showQuote?: boolean }) {
  const now = useNow();
  const live = thread.comments.filter((c) => !c.deletedAt);
  const quote = (thread.metadata as { quote?: string } | undefined)?.quote;
  const leaveThread = useLeaveRef<HTMLDivElement>(() => {
    const now = store.getThreads().get(thread.id);
    return !now || !!now.deletedAt || now.resolved !== thread.resolved || !now.comments.some((c) => !c.deletedAt);
  }, "is-row-leaving", MOTION.base);
  const leaveComment = useLeaveRef<HTMLDivElement>((el) => {
    const now = store.getThreads().get(thread.id);
    const comment = now?.comments.find((c) => c.id === el.dataset.commentId);
    return !!now && !now.deletedAt && (!comment || !!comment.deletedAt);
  }, "is-row-leaving", MOTION.base);
  const box = useRef<HTMLDivElement>(null);
  useFlip(box, ".n-comment[data-comment-id]", "data-comment-id", [live.map((c) => c.id).join()], { enter: true });
  const [setBox] = useState(() => (el: HTMLDivElement | null) => {
    box.current = el;
    return leaveThread(el);
  });
  return (
    <div ref={setBox} className={`n-thread${thread.resolved ? " is-resolved" : ""}${active ? " is-active" : ""}`} data-testid="comment-thread" data-thread-id={thread.id} onClick={onSelect}>
      <div className="n-thread-head">
        {showQuote && quote ? <div className="n-thread-quote">{quote}</div> : <span className="n-spacer" />}
        <button
          type="button"
          className="n-icon-button"
          title={thread.resolved ? "Re-open" : "Resolve"}
          aria-label={thread.resolved ? "Re-open thread" : "Resolve thread"}
          data-testid="thread-resolve"
          onClick={(e) => {
            e.stopPropagation();
            void (thread.resolved ? store.unresolveThread({ threadId: thread.id }) : store.resolveThread({ threadId: thread.id }));
          }}
        >
          <Icon name={thread.resolved ? "restore" : "resolve"} />
        </button>
      </div>
      {live.map((comment) => {
        const meta = (comment.metadata ?? {}) as Partial<CommentMeta>;
        return (
          <div key={comment.id} ref={leaveComment} className="n-comment" data-testid="comment" data-comment-id={comment.id}>
            <Avatar name={meta.name ?? "Someone"} color={meta.color ?? ""} />
            <div className="n-comment-main">
              <div className="n-comment-head">
                <span className="n-comment-name">{meta.name ?? "Someone"}</span>
                <span className="n-comment-time">{relativeTime(new Date(comment.createdAt).getTime(), now)}</span>
                {comment.userId === me.deviceId ? (
                  <button
                    type="button"
                    className="n-comment-delete"
                    aria-label="Delete comment"
                    onClick={(e) => {
                      e.stopPropagation();
                      void (live.length === 1 ? store.deleteThread({ threadId: thread.id }) : store.deleteComment({ threadId: thread.id, commentId: comment.id }));
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                ) : null}
              </div>
              <div className="n-comment-text">{commentText(comment.body)}</div>
            </div>
          </div>
        );
      })}
      {!thread.resolved ? (
        <div onClick={(e) => e.stopPropagation()}>
          <Composer compact me={me} placeholder="Reply…" onSubmit={(text) => void store.addComment({ threadId: thread.id, comment: { body: commentBody(text), metadata: { name: me.name, color: me.color } } })} />
        </div>
      ) : null}
    </div>
  );
}

export function CommentsPanel({ store, me, selected, onSelect, onClose, closing }: { store: ThreadStore; me: Me; selected?: string; onSelect: (thread: ThreadData) => void; onClose: () => void; closing?: boolean }) {
  const threads = useThreadMap(store);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const panel = useClosingFocus<HTMLElement>(!!closing);
  const list = [...threads.values()].filter((t) => !t.deletedAt && t.comments.some((c) => !c.deletedAt) && t.resolved === (tab === "resolved")).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const body = useRef<HTMLDivElement>(null);
  useFlip(body, ".n-thread[data-thread-id]", "data-thread-id", [list.map((t) => t.id).join(), tab]);
  return (
    <aside ref={panel} inert={!!closing} aria-hidden={closing || undefined} className={`n-side-panel${closing ? " is-closing" : ""}`} data-testid={closing ? undefined : "comments-panel"} aria-label="Comments">
      <div className="n-side-panel-inner">
      <div className="n-side-panel-head">
        <span className="n-side-panel-title">Comments</span>
        <div className="n-seg">
          <button type="button" className={tab === "open" ? "is-on" : ""} onClick={() => setTab("open")}>
            Open
          </button>
          <button type="button" className={tab === "resolved" ? "is-on" : ""} onClick={() => setTab("resolved")}>
            Resolved
          </button>
        </div>
        <span className="n-spacer" />
        <button type="button" className="n-icon-button" aria-label="Close comments" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="n-side-panel-body" ref={body}>
        {!list.length ? (
          <div className="n-empty-note">
            <Icon name="comment" size={22} />
            <div>{tab === "open" ? "No open comments yet" : "No resolved comments"}</div>
            <div className="n-muted">{tab === "open" ? "Select text and press ⌘⇧M, or add a comment under the title." : "Resolved threads land here."}</div>
          </div>
        ) : null}
        {list.map((thread) => (
          <ThreadView key={thread.id} thread={thread} store={store} me={me} active={selected === thread.id} onSelect={() => onSelect(thread)} />
        ))}
      </div>
      </div>
    </aside>
  );
}

export function PageComments({ store, me, composing, onDone }: { store: ThreadStore; me: Me; composing: boolean; onDone: () => void }) {
  const threads = useThreadMap(store);
  const list = [...threads.values()].filter((t) => (t.metadata as { page?: boolean } | undefined)?.page && !t.deletedAt && !t.resolved && t.comments.some((c) => !c.deletedAt));
  const box = useRef<HTMLDivElement>(null);
  useFlip(box, ".n-thread[data-thread-id]", "data-thread-id", [list.map((t) => t.id).join(), composing]);
  if (!list.length && !composing) return null;
  return (
    <div className="n-page-comments" data-testid="page-comments" ref={box}>
      {list.map((thread) => (
        <ThreadView key={thread.id} thread={thread} store={store} me={me} showQuote={false} />
      ))}
      {composing || !list.length ? (
        <Composer
          me={me}
          autoFocus={composing}
          placeholder="Add a comment…"
          onCancel={onDone}
          onSubmit={(text) => {
            void store.createThread({ initialComment: { body: commentBody(text), metadata: { name: me.name, color: me.color } }, metadata: { page: true } });
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}
