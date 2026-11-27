import { BlockNoteView } from "@blocknote/mantine";
import { exitRef } from "../ui/motion";
import { useCreateBlockNote } from "@blocknote/react";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { blocksOf, displayTitle, getPage } from "../../shared/model";
import type { PageId, VersionInfo, WorkspaceId } from "../../shared/protocol";
import { useApp } from "../app/context";
import { fromBase64 } from "../client/encoding";
import { notesTheme } from "../editor/NoteEditor";
import { NotesEnvContext, type NotesEnv } from "../editor/env";
import { fragmentBlocks } from "../editor/ops";
import { schema } from "../editor/schema";
import { Icon } from "../ui/icons";
import { toast } from "../ui/toast";

function formatWhen(at: number) {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function Preview({ blocks, env }: { blocks: unknown[]; env: NotesEnv }) {
  const editor = useCreateBlockNote({ schema, initialContent: blocks.length ? (blocks as never) : undefined }, [blocks]);
  return (
    <NotesEnvContext value={env}>
      <BlockNoteView editor={editor} editable={false} theme={notesTheme} formattingToolbar={false} slashMenu={false} sideMenu={false} linkToolbar={false} emojiPicker={false} comments={false} filePanel={false} tableHandles={false} className="n-editor" />
    </NotesEnvContext>
  );
}

const CURRENT = "current";

export function HistorySheet({ workspace, page, onClose }: { workspace: WorkspaceId; page: PageId; onClose: () => void }) {
  const app = useApp();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tree = app.trees.get(workspace)!;
  const meta = getPage(tree, page);
  const env: NotesEnv = useMemo(
    () => ({ client: app.client, workspace, page, tree, trees: app.trees, readOnly: true, openPage: () => {}, createChildPage: async () => "", openUrl: () => {} }),
    [app.client, workspace, page, tree, app.trees],
  );
  useEffect(() => {
    void app.client
      .call("history", { workspace, page })
      .then((list) => {
        setVersions(list);
        setSelected(CURRENT);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [workspace, page]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setBlocks(null);
    if (selected === CURRENT) {
      const open = app.client.open(workspace, `p:${page}`);
      void open.synced.then(() => {
        if (live) setBlocks(fragmentBlocks(blocksOf(open.doc)));
        open.release();
      });
      return () => {
        live = false;
      };
    }
    void app.client.call("versionState", { workspace, page, version: selected }).then(({ state }) => {
      if (!live) return;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, fromBase64(state));
      setBlocks(fragmentBlocks(blocksOf(doc)));
    });
    return () => {
      live = false;
    };
  }, [selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const who = (id: string) => (id === app.me.deviceId || id === app.me.name ? "You" : (app.presence.find((p) => p.deviceId === id)?.name ?? id));
  return (
    <div className="n-modal-scrim" ref={exitRef<HTMLDivElement>("is-modal-leaving")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="n-history" role="dialog" aria-label="Version history" data-testid="history">
        <div className={`n-history-preview n-page font-${meta?.font ?? "default"}${meta?.smallText ? " is-small" : ""}`}>
          <h1 className="n-title">{meta ? displayTitle(meta) : ""}</h1>
          {blocks ? <Preview key={selected ?? ""} blocks={blocks} env={env} /> : <div className="n-editor-loading" aria-busy="true" />}
        </div>
        <div className="n-history-side">
          <div className="n-side-panel-head">
            <span className="n-side-panel-title">Version history</span>
            <span className="n-spacer" />
            <button type="button" className="n-icon-button" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          <div className="n-history-list">
            {error ? <div className="n-muted">{error}</div> : null}
            {versions && !versions.length ? <div className="n-empty-note">No earlier versions yet</div> : null}
            {versions ? (
              <button type="button" className={`n-history-row${selected === CURRENT ? " is-selected" : ""}`} data-testid="history-row" onClick={() => setSelected(CURRENT)}>
                <span className="n-history-when">Current version</span>
                <span className="n-history-who">{meta ? formatWhen(meta.updatedAt) : ""}</span>
              </button>
            ) : null}
            {versions?.map((v) => (
              <button key={v.id} type="button" className={`n-history-row${selected === v.id ? " is-selected" : ""}`} data-testid="history-row" onClick={() => setSelected(v.id)}>
                <span className="n-history-when">{formatWhen(v.at)}</span>
                <span className="n-history-who">
                  {who(v.by)}
                  {` · ${Math.max(1, Math.round(v.size / 1024))} KB`}
                </span>
              </button>
            ))}
          </div>
          <div className="n-history-foot">
            <button
              type="button"
              className="n-button is-primary"
              data-testid="history-restore"
              disabled={!selected || selected === CURRENT}
              onClick={async () => {
                if (!selected) return;
                await app.client.call("restoreVersion", { workspace, page, version: selected });
                toast("Restored this version");
                onClose();
              }}
            >
              Restore version
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
