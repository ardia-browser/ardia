import { FilePanelExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useExtension, type FilePanelProps } from "@blocknote/react";
import { useRef, useState } from "react";
import { Icon } from "../ui/icons";
import type { NotesEditor } from "./schema";

const LABELS: Record<string, string> = { image: "image", video: "video", audio: "audio", file: "file" };

export function NotesFilePanel({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const panel = useExtension(FilePanelExtension);
  const block = editor.getBlock(blockId) as { id: string; type: string } | undefined;
  const [tab, setTab] = useState<"upload" | "link">("upload");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  if (!block) return null;
  const kind = LABELS[block.type] ?? "file";
  const accept = block.type === "image" ? "image/*" : block.type === "video" ? "video/*" : block.type === "audio" ? "audio/*" : "*/*";
  const upload = async (file: File) => {
    if (!editor.uploadFile) return;
    setBusy(true);
    setError(null);
    try {
      const ref = await editor.uploadFile(file, blockId);
      editor.updateBlock(blockId, { props: { name: file.name, url: typeof ref === "string" ? ref : String((ref as { url?: string }).url ?? "") } } as never);
      panel.closeMenu();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="n-popover n-file-panel" data-testid="file-panel">
      <div className="n-emoji-tabs">
        <button type="button" className={tab === "upload" ? "is-on" : ""} onClick={() => setTab("upload")}>
          Upload
        </button>
        <button type="button" className={tab === "link" ? "is-on" : ""} onClick={() => setTab("link")}>
          Embed link
        </button>
      </div>
      {tab === "upload" ? (
        <div className="n-file-panel-body">
          <button type="button" className="n-button is-wide" disabled={busy} onClick={() => input.current?.click()} data-testid="file-upload">
            <Icon name="upload" size={14} />
            {busy ? "Uploading…" : `Upload ${kind}`}
          </button>
          <div className="n-muted">The file is stored in this workspace and stays available offline.</div>
          {error ? <div className="n-file-error">{error}</div> : null}
          <input
            ref={input}
            type="file"
            accept={accept}
            hidden
            data-testid="file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <form
          className="n-file-panel-body"
          onSubmit={(e) => {
            e.preventDefault();
            const value = url.trim();
            if (!value) return;
            editor.updateBlock(blockId, { props: { url: value, name: value.split("/").pop() ?? value } } as never);
            panel.closeMenu();
          }}
        >
          <input className="n-input" autoFocus placeholder={`Paste the ${kind} link…`} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="n-button is-primary is-wide" disabled={!url.trim()}>
            Embed {kind}
          </button>
        </form>
      )}
    </div>
  );
}
