import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { updatePage, type PageMeta } from "../../shared/model";
import type { NotesClient } from "../client/types";
import { useFileIcon } from "../app/files";
import { EmojiPicker, randomEmoji } from "../ui/EmojiPicker";
import { Icon, PageIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { useAppearance } from "../ui/motion";
import { COLORS, GRADIENTS, coverStyle } from "./covers";

export function Cover({ meta, tree, client, workspace, readOnly, by }: { meta: PageMeta; tree: Y.Doc; client: NotesClient; workspace: string; readOnly: boolean; by: string }) {
  const resolve = useFileIcon(client, workspace);
  const url = meta.cover.startsWith("file:") ? resolve(meta.cover) : null;
  const [gallery, setGallery] = useState<HTMLElement | null>(null);
  const [repositioning, setRepositioning] = useState(false);
  const [y, setY] = useState(meta.coverY);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setY(meta.coverY), [meta.coverY]);
  const cover = useAppearance(meta.cover, ref);
  if (!cover) return null;
  const onPointerDown = (event: React.PointerEvent) => {
    if (!repositioning || !url) return;
    event.preventDefault();
    const startY = event.clientY;
    const startPos = y;
    const height = ref.current?.getBoundingClientRect().height ?? 200;
    const move = (e: PointerEvent) => setY(Math.max(0, Math.min(100, startPos - ((e.clientY - startY) / height) * 100)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className={`n-cover${repositioning ? " is-repositioning" : ""}`} style={coverStyle(cover, url, y)} data-testid={meta.cover ? "cover" : undefined} onPointerDown={onPointerDown}>
      {repositioning ? <div className="n-cover-hint">Drag image to reposition</div> : null}
      {!readOnly ? (
        <div className="n-cover-actions">
          {repositioning ? (
            <>
              <button
                type="button"
                className="n-chip-button"
                onClick={() => {
                  updatePage(tree, meta.id, { coverY: Math.round(y) }, by);
                  setRepositioning(false);
                }}
              >
                Save position
              </button>
              <button
                type="button"
                className="n-chip-button"
                onClick={() => {
                  setY(meta.coverY);
                  setRepositioning(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="n-chip-button" data-testid="cover-change" onClick={(e) => setGallery(e.currentTarget)}>
                Change cover
              </button>
              {url ? (
                <button type="button" className="n-chip-button" onClick={() => setRepositioning(true)}>
                  Reposition
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {gallery ? <CoverGallery anchor={gallery} onClose={() => setGallery(null)} tree={tree} meta={meta} client={client} workspace={workspace} by={by} /> : null}
    </div>
  );
}

export function CoverGallery({ anchor, onClose, tree, meta, client, workspace, by }: { anchor: HTMLElement; onClose: () => void; tree: Y.Doc; meta: PageMeta; client: NotesClient; workspace: string; by: string }) {
  const [tab, setTab] = useState<"gallery" | "upload">("gallery");
  const file = useRef<HTMLInputElement>(null);
  const set = (cover: string) => {
    updatePage(tree, meta.id, { cover, coverY: 50 }, by);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={520} placement="bottom-end" label="Cover">
      <div className="n-cover-gallery" data-testid="cover-gallery">
        <div className="n-emoji-tabs">
          <button type="button" className={tab === "gallery" ? "is-on" : ""} onClick={() => setTab("gallery")}>
            Gallery
          </button>
          <button type="button" className={tab === "upload" ? "is-on" : ""} onClick={() => setTab("upload")}>
            Upload
          </button>
          <span className="n-spacer" />
          <button type="button" className="n-emoji-remove" data-testid="cover-remove" onClick={() => set("")}>
            Remove
          </button>
        </div>
        {tab === "gallery" ? (
          <div className="n-cover-scroll">
            <div className="n-menu-heading">Gradients</div>
            <div className="n-cover-grid">
              {GRADIENTS.map((g, i) => (
                <button key={g} type="button" className="n-cover-swatch" style={{ background: g }} aria-label={`Gradient ${i + 1}`} data-testid="cover-option" onClick={() => set(`gradient:${i}`)} />
              ))}
            </div>
            <div className="n-menu-heading">Colours</div>
            <div className="n-cover-grid">
              {COLORS.map((c, i) => (
                <button key={c} type="button" className="n-cover-swatch" style={{ background: c }} aria-label={`Colour ${i + 1}`} onClick={() => set(`color:${i}`)} />
              ))}
            </div>
          </div>
        ) : (
          <div className="n-emoji-upload">
            <button type="button" className="n-button" onClick={() => file.current?.click()}>
              Upload file
            </button>
            <div className="n-muted">Images wider than 1500 pixels work best.</div>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              data-testid="cover-file"
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                if (!picked) return;
                const ref = await client.upload(workspace, picked, picked.name);
                set(ref);
              }}
            />
          </div>
        )}
      </div>
    </Popover>
  );
}

export function PageIconButton({ meta, tree, client, workspace, readOnly, by, hasCover }: { meta: PageMeta; tree: Y.Doc; client: NotesClient; workspace: string; readOnly: boolean; by: string; hasCover: boolean }) {
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const resolve = useFileIcon(client, workspace);
  const box = useRef<HTMLDivElement>(null);
  const icon = useAppearance(meta.icon, box);
  if (!icon) return null;
  return (
    <div className={`n-page-icon${hasCover ? " is-over-cover" : ""}`} ref={box}>
      <button type="button" className="n-page-icon-button" disabled={readOnly} aria-label="Change icon" data-testid={meta.icon ? "page-icon" : undefined} onClick={(e) => setPicker(e.currentTarget)}>
        <PageIcon icon={icon} size={78} resolveFile={resolve} />
      </button>
      {picker ? (
        <IconPickerPopover
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(icon) => updatePage(tree, meta.id, { icon }, by)}
          onUpload={async (file) => updatePage(tree, meta.id, { icon: await client.upload(workspace, file, file.name) }, by)}
        />
      ) : null}
    </div>
  );
}

export function IconPickerPopover({ anchor, onClose, onPick, onUpload }: { anchor: HTMLElement; onClose: () => void; onPick: (icon: string) => void; onUpload?: (file: File) => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={408} label="Icon">
      <EmojiPicker
        onPick={(e) => {
          onPick(e);
          onClose();
        }}
        onRemove={() => {
          onPick("");
          onClose();
        }}
        onUpload={
          onUpload
            ? (file) => {
                onUpload(file);
                onClose();
              }
            : undefined
        }
      />
    </Popover>
  );
}

export function HeaderControls({ meta, tree, by, onComment, readOnly }: { meta: PageMeta; tree: Y.Doc; by: string; onComment: () => void; readOnly: boolean }) {
  if (readOnly) return <div className="n-header-controls is-empty" />;
  return (
    <div className="n-header-controls" data-testid="header-controls">
      {!meta.icon ? (
        <button type="button" className="n-ghost-button" data-testid="add-icon" onClick={() => void randomEmoji().then((icon) => updatePage(tree, meta.id, { icon }, by))}>
          <Icon name="smile" size={14} />
          Add icon
        </button>
      ) : null}
      {!meta.cover ? (
        <button type="button" className="n-ghost-button" data-testid="add-cover" onClick={() => updatePage(tree, meta.id, { cover: `gradient:${Math.floor(Math.random() * GRADIENTS.length)}`, coverY: 50 }, by)}>
          <Icon name="image" size={14} />
          Add cover
        </button>
      ) : null}
      <button type="button" className="n-ghost-button" data-testid="add-comment" onClick={onComment}>
        <Icon name="comment" size={14} />
        Add comment
      </button>
    </div>
  );
}

export function PageTitle({ meta, tree, by, readOnly, onEnter, onArrowDown }: { meta: PageMeta; tree: Y.Doc; by: string; readOnly: boolean; onEnter: (rest: string) => void; onArrowDown: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el && el.textContent !== meta.title) el.textContent = meta.title;
  }, [meta.title]);
  useEffect(() => {
    if (!meta.title && !readOnly && Date.now() - meta.createdAt < 4000) ref.current?.focus();
  }, []);
  return (
    <h1
      ref={ref}
      className="n-title"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-label="Page title"
      data-placeholder="Untitled"
      data-testid="page-title"
      data-empty={!meta.title ? "true" : undefined}
      onInput={(e) => {
        const text = (e.currentTarget.textContent ?? "").replace(/\n/g, " ");
        e.currentTarget.dataset.empty = text ? "" : "true";
        updatePage(tree, meta.id, { title: text }, by);
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          const sel = window.getSelection();
          const el = e.currentTarget;
          const full = el.textContent ?? "";
          let offset = full.length;
          if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
            const range = sel.getRangeAt(0).cloneRange();
            range.selectNodeContents(el);
            range.setEnd(sel.anchorNode!, sel.anchorOffset);
            offset = range.toString().length;
          }
          const rest = full.slice(offset);
          if (rest) {
            el.textContent = full.slice(0, offset);
            updatePage(tree, meta.id, { title: full.slice(0, offset) }, by);
          }
          onEnter(rest);
        } else if (e.key === "ArrowDown" && !e.shiftKey) {
          const el = e.currentTarget;
          const sel = window.getSelection();
          const caret = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
          const box = el.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 48;
          if (!caret || caret.height === 0 || caret.bottom > box.bottom - lineHeight) {
            e.preventDefault();
            onArrowDown();
          }
        }
      }}
    />
  );
}
