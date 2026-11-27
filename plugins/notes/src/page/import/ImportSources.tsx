import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { FEATURED_SOURCES, IMPORT_SOURCES, importSource, type ImportPick, type ImportSourceId, type ImportSourceInfo } from "../../shared/importSources";
import { APPLE_NOTES_APP, BRAND_PATHS, BrandMark, useAppIcon } from "./brandIcons";
import { NotionDetail } from "./NotionSource";
import "./import.css";

export function gridColumns(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  const count = template.split(" ").filter((part) => part && part !== "none").length;
  return Math.max(1, count);
}

export function onGridKey(event: KeyboardEvent<HTMLElement>, grid: HTMLElement | null, selector = "[data-grid-item]") {
  if (!grid) return;
  const items = [...grid.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.hasAttribute("disabled"));
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const columns = gridColumns(grid);
  let next = index;
  if (event.key === "ArrowRight") next = index + 1;
  else if (event.key === "ArrowLeft") next = index - 1;
  else if (event.key === "ArrowDown") next = index + columns;
  else if (event.key === "ArrowUp") next = index - columns;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  const target = items[Math.max(0, Math.min(items.length - 1, next))];
  target?.focus();
}

export function Monogram({ letter, size = 36 }: { letter: string; size?: number }) {
  return (
    <span className="n-imp-monogram" style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }} aria-hidden="true">
      {letter}
    </span>
  );
}

function AppleNotesFallback({ size }: { size: number }) {
  return (
    <span className="n-imp-notes-tile" style={{ width: size, height: size }} aria-hidden="true">
      <span className="n-imp-notes-band" />
      <span className="n-imp-notes-lines" />
    </span>
  );
}

function AppleNotesIcon({ size }: { size: number }) {
  const icon = useAppIcon(APPLE_NOTES_APP, Math.max(64, size * 2));
  if (!icon) return <AppleNotesFallback size={size} />;
  const art = Math.round(size * 1.22);
  return (
    <span className="n-imp-app-icon-box" style={{ width: size, height: size }} aria-hidden="true">
      <img className="n-imp-app-icon" src={icon} width={art} height={art} alt="" data-testid="import-app-icon" />
    </span>
  );
}

export function SourceIcon({ source, size = 36 }: { source: ImportSourceInfo; size?: number }) {
  if (source.id === "apple-notes") return <AppleNotesIcon size={size} />;
  if (BRAND_PATHS[source.id])
    return (
      <span className="n-imp-brand" style={{ width: size, height: size }} aria-hidden="true">
        <BrandMark source={source.id} size={Math.round(size * 0.6)} />
      </span>
    );
  return <Monogram letter={source.monogram} size={size} />;
}

export const OTHER_SOURCES: ImportSourceId[] = ["markdown", ...IMPORT_SOURCES.map((s) => s.id).filter((id) => id !== "markdown" && !FEATURED_SOURCES.includes(id))];

export function SourceGrid({
  sources = FEATURED_SOURCES,
  selected,
  onSelect,
  extra,
  size = "large",
  label = "Import from",
  testId = "import-sources",
}: {
  sources?: ImportSourceId[];
  selected: ImportSourceId | null;
  onSelect: (id: ImportSourceId) => void;
  extra?: ReactNode;
  size?: "large" | "small";
  label?: string;
  testId?: string;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const list = sources.map((id) => importSource(id)).filter((s): s is ImportSourceInfo => !!s);
  const focusIndex = Math.max(0, list.findIndex((s) => s.id === selected));
  return (
    <div ref={grid} className={`n-imp-grid is-${size}`} role="radiogroup" aria-label={label} onKeyDown={(e) => onGridKey(e, grid.current)} data-testid={testId}>
      {list.map((source, i) => (
        <button
          key={source.id}
          type="button"
          role="radio"
          aria-checked={selected === source.id}
          tabIndex={i === focusIndex ? 0 : -1}
          className={`n-imp-tile${selected === source.id ? " is-selected" : ""}`}
          data-grid-item
          data-testid={`import-source-${source.id}`}
          onClick={() => onSelect(source.id)}
          style={{ ["--i" as string]: i }}
        >
          <SourceIcon source={source} size={size === "large" ? 38 : 28} />
          <span className="n-imp-tile-title">{source.title}</span>
        </button>
      ))}
      {extra}
    </div>
  );
}

export const pickLabel = (source: ImportSourceInfo, pick: ImportPick) => (pick === "app" ? (source.id === "apple-notes" ? "Import from Notes" : `Import from ${source.title}`) : pick === "folder" ? "Choose folder…" : "Choose file…");
export const otherPickLabel = (source: ImportSourceInfo, pick: ImportPick) => (pick === "folder" ? (source.picks.includes("app") ? "Choose an exported folder instead" : "Choose a folder instead") : "Choose a file instead");

export type SourceDetailProps = { source: ImportSourceInfo; onStart: (pick: ImportPick) => void; busy?: boolean };

export function SourceDetail(props: SourceDetailProps) {
  if (props.source.id === "notion") return <NotionDetail {...props} />;
  return <GenericSourceDetail {...props} />;
}

export function GenericSourceDetail({ source, onStart, busy, note }: SourceDetailProps & { note?: string }) {
  const [primary, secondary] = source.picks;
  return (
    <div className="n-imp-detail" data-testid="import-detail" key={source.id}>
      <SourceIcon source={source} size={42} />
      <div className="n-imp-detail-text">
        <div className="n-imp-detail-title">{source.title}</div>
        {note ? (
          <p className="n-imp-detail-hint" data-testid="import-detail-note">
            {note}
          </p>
        ) : null}
        <p className="n-imp-detail-hint">{source.hint}</p>
      </div>
      <div className="n-imp-detail-actions">
        <button type="button" className="n-ob-primary" disabled={busy} onClick={() => primary && onStart(primary)} data-testid="import-choose">
          {busy ? "Waiting for you…" : pickLabel(source, primary ?? "file")}
        </button>
        {secondary ? (
          <button type="button" className="n-ob-link" disabled={busy} onClick={() => onStart(secondary)} data-testid="import-choose-other">
            {otherPickLabel(source, secondary)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
