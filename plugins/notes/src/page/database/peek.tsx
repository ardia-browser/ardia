import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PageId } from "../../shared/protocol";
import { updatePage, type PageMeta } from "../../shared/model";
import { updateSettings } from "../../shared/database";
import type { DatabaseModel } from "./data";
import { Icon } from "./icons";
import { RowIcon } from "./cells";
import { RowPropertiesView } from "./propertyList";
import { anyLayerOpen, IconButton, Menu, MenuItem, Popover, usePopover } from "./ui";
import { registerCss } from "./styles";
import { exitRef } from "../ui/motion";

const peekExit = exitRef<HTMLDivElement>("is-peek-leaving", 160);

export function Peek({ m, row, order, mode, onClose, onOpen, onFull, renderBody }: { m: DatabaseModel; row: PageMeta; order: PageId[]; mode: "side" | "center"; onClose: () => void; onOpen: (id: PageId) => void; onFull: (id: PageId) => void; renderBody?: (row: PageMeta) => ReactNode }) {
  const index = order.indexOf(row.id);
  const prev = index > 0 ? order[index - 1] : undefined;
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : undefined;
  const [title, setTitle] = useState(row.title);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const focused = useRef(false);
  const modeMenu = usePopover();
  useEffect(() => {
    if (!focused.current) setTitle(row.title);
  }, [row.title, row.id]);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyLayerOpen()) return;
      const inField = (e.target as HTMLElement).closest?.("input,textarea,[contenteditable=true],.ProseMirror");
      if (e.key === "Escape" && !inField) {
        e.preventDefault();
        onClose();
      }
      if (!inField && (e.key === "ArrowUp" || e.key === "k") && e.ctrlKey && prev) onOpen(prev);
      if (!inField && (e.key === "ArrowDown" || e.key === "j") && e.ctrlKey && next) onOpen(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onOpen, prev, next]);
  const commit = () => {
    if (title !== row.title) updatePage(m.tree, row.id, { title }, m.me.deviceId);
  };
  return createPortal(
    <div ref={peekExit} className={`db-root db-peek-layer is-${mode}`} data-testid="db-peek-layer" onPointerDown={(e) => {
      if (e.target === e.currentTarget && mode === "center") onClose();
    }}>
      <div className={`db-peek is-${mode}`} data-testid="db-peek" data-row={row.id} role="dialog" aria-label={row.title || "Untitled"}>
        <div className="db-peek-bar">
          <IconButton icon={mode === "side" ? "chevronRight" : "x"} title="Close" testId="db-peek-close" onClick={onClose} />
          <IconButton icon="expand" title="Open as full page" testId="db-peek-full" onClick={() => onFull(row.id)} />
          <IconButton icon={mode === "side" ? "sidePeek" : "centerPeek"} title="Peek mode" onClick={(e) => modeMenu.open(e.currentTarget)} />
          <span className="db-flex" />
          <IconButton icon="chevronUp" title="Previous page" testId="db-peek-prev" className={prev ? "" : "is-disabled"} onClick={() => prev && onOpen(prev)} />
          <IconButton icon="chevronDown" title="Next page" testId="db-peek-next" className={next ? "" : "is-disabled"} onClick={() => next && onOpen(next)} />
        </div>
        <div className="db-peek-scroll" key={row.id}>
          <div className="db-peek-content">
            {row.icon && (
              <div className="db-peek-icon">
                <RowIcon m={m} row={row} size={56} />
              </div>
            )}
            {row.isTemplate && <div className="db-template-note">You're editing a template in {m.sourceMeta?.title || "Untitled"}</div>}
            <textarea
              ref={titleRef}
              className="db-peek-title"
              rows={1}
              value={title}
              placeholder="Untitled"
              data-testid="db-peek-title"
              onFocus={() => (focused.current = true)}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
              onBlur={() => {
                focused.current = false;
                commit();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
            <RowPropertiesView m={m} row={row} />
            <div className="db-peek-divider" />
            <div className="db-peek-body" data-testid="db-peek-body">
              {renderBody ? (
                renderBody(row)
              ) : (
                <button type="button" className="db-rp-more" onClick={() => onFull(row.id)}>
                  <Icon name="page" size={14} /> Open page to add content
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {modeMenu.state && (
        <Popover anchor={modeMenu.state.anchor} onClose={modeMenu.close} width={200}>
          <Menu>
            <MenuItem icon="sidePeek" label="Side peek" checked={m.settings.openAs === "side"} onSelect={() => {
              updateSettings(m.doc, { openAs: "side" });
              modeMenu.close();
            }} />
            <MenuItem icon="centerPeek" label="Center peek" checked={m.settings.openAs === "center"} onSelect={() => {
              updateSettings(m.doc, { openAs: "center" });
              modeMenu.close();
            }} />
            <MenuItem icon="fullPage" label="Full page" checked={m.settings.openAs === "full"} onSelect={() => {
              updateSettings(m.doc, { openAs: "full" });
              modeMenu.close();
              onFull(row.id);
            }} />
          </Menu>
        </Popover>
      )}
    </div>,
    document.body,
  );
}

registerCss(
  "peek",
  `
.db-peek-layer { position: fixed; inset: 0; z-index: 900; pointer-events: none; }
.db-peek-layer.is-center { background: var(--n-scrim); pointer-events: auto; display: flex; align-items: center; justify-content: center; padding: 48px 24px; animation: db-fade var(--n-base, 160ms) var(--n-ease-out) both; }
.db-peek { pointer-events: auto; background: var(--n-glass-sheet); -webkit-backdrop-filter: var(--n-glass-sheet-filter); backdrop-filter: var(--n-glass-sheet-filter); display: flex; flex-direction: column; overflow: hidden; }
.db-peek.is-side { position: absolute; top: 8px; right: 8px; bottom: 8px; width: min(720px, max(480px, 46vw)); border-radius: var(--n-r-sheet, 16px); background: var(--n-peek-fill); box-shadow: var(--n-glass-edge), var(--n-shadow-sheet); animation: db-slide var(--n-slow, 260ms) var(--m-ease-soft) both; }
.db-peek.is-center { width: min(960px, 100%); height: min(calc(100vh - 96px), 880px); max-height: 100%; border-radius: var(--n-r-sheet, 16px); box-shadow: var(--n-glass-edge), var(--n-shadow-sheet); animation: db-rise 220ms var(--m-ease-soft) both; }
@keyframes db-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes db-rise { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes db-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .db-peek, .db-peek-layer { animation-name: db-fade !important; } }
.db-peek-bar { display: flex; align-items: center; gap: 2px; height: 44px; padding: 0 10px; flex: none; }
.db-peek-bar .is-disabled { opacity: .35; pointer-events: none; }
.db-peek-scroll { flex: 1; overflow: auto; }
.db-peek-content { padding: 16px 48px 64px; max-width: 900px; margin: 0 auto; }
.db-peek.is-center .db-peek-content { padding: 8px 64px 48px; }
.db-peek-icon { margin-bottom: 8px; line-height: 1; }
.db-peek-title { display: block; width: 100%; border: none; outline: none; resize: none; background: transparent; color: var(--n-text); font: inherit; font-size: 32px; line-height: 1.2; font-weight: 700; padding: 0; margin: 0 0 12px; overflow: hidden; }
.db-peek-title::placeholder { color: var(--n-text-3); }
.db-peek-divider { height: 0.5px; background: var(--n-divider); margin: 8px 0 16px; }
.db-template-note { font-size: var(--n-t-small, 12px); color: var(--n-text-2); background: var(--n-raised); box-shadow: inset 0 0 0 1px var(--n-group-border); border-radius: var(--n-r-tile, 8px); padding: 6px 10px; margin-bottom: 10px; }
`,
);
