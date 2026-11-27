import { Fragment, useEffect, useRef, useState } from "react";
import { exitRef, MOTION, useFlip, useHeightTween, useLeaveRef } from "../ui/motion";
import { displayTitle, getPage, isArchivedDeep, ancestorsOf } from "../../shared/model";
import type { SearchHit } from "../../shared/protocol";
import { useApp } from "../app/context";
import { relativeTime, useNow } from "../app/hooks";
import { Icon, PageIcon } from "../ui/icons";

function terms(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const words = terms(query).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

export function SearchModal({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const app = useApp();
  const now = useNow();
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void app.client
        .call("search", { query, workspace: app.activeWorkspace || undefined, limit: 30 })
        .then((h) => live && setHits(h))
        .catch(() => live && setHits([]));
    }, 90);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, app.activeWorkspace]);
  useEffect(() => setActive(0), [query, hits]);
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const recent = app.recents
    .filter((r) => r.workspace === app.activeWorkspace)
    .map((r) => {
      const tree = app.trees.get(r.workspace);
      const meta = tree ? getPage(tree, r.page) : null;
      if (!tree || !meta || isArchivedDeep(tree, r.page)) return null;
      return { workspace: r.workspace, page: r.page, title: displayTitle(meta), icon: meta.icon, path: ancestorsOf(tree, r.page).map((a) => displayTitle(a)), snippet: "", score: 0, updatedAt: meta.updatedAt } satisfies SearchHit;
    })
    .filter((r): r is SearchHit => !!r)
    .slice(0, 10);
  const rows = hits ?? recent;
  const shownOnce = useRef(false);
  useFlip(listRef, ".n-palette-row[data-flip]", "data-flip", [rows.map((r) => `${r.workspace}:${r.page}`).join()], { enter: () => shownOnce.current, enterShift: 0, duration: MOTION.fast });
  useEffect(() => {
    shownOnce.current = true;
  }, []);
  const rowKeys = rows.map((r) => `${r.workspace}:${r.page}`).join("|") + (hits && !hits.length ? "|empty" : "");
  useHeightTween(paletteRef, rowKeys);
  const liveKeys = new Set(rows.map((r) => `${r.workspace}:${r.page}`));
  const leaveRow = useLeaveRef<HTMLButtonElement>((el) => !liveKeys.has(el.dataset.flip ?? ""), "is-row-leaving", MOTION.fast);
  const open = (hit: SearchHit, newTab: boolean) => {
    onClose();
    app.openPage(hit.page, { workspace: hit.workspace, newTab });
  };
  return (
    <div className="n-modal-scrim is-top" ref={exitRef<HTMLDivElement>("is-modal-leaving")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={paletteRef} className="n-palette n-search" role="dialog" aria-label="Search" data-testid="search-modal">
        <div className="n-palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Search or ask a question in Notes…"
            aria-label="Search"
            data-testid="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && rows[active]) {
                e.preventDefault();
                open(rows[active]!, e.metaKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {query ? (
            <button type="button" className="n-icon-button is-small" aria-label="Clear" onClick={() => setQuery("")}>
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
        <div className="n-palette-list" ref={listRef}>
          <div className="n-menu-heading">{hits ? (hits.length ? "Best matches" : "") : recent.length ? "Recent" : ""}</div>
          {hits && !hits.length ? (
            <div className="n-search-empty" data-testid="search-empty">
              <Icon name="search" size={22} />
              <div>No results for “{query}”</div>
              <div className="n-muted">Try a different word, or check the Trash.</div>
            </div>
          ) : null}
          {rows.map((hit, i) => (
            <button
              key={`${hit.workspace}:${hit.page}`}
              data-flip={`${hit.workspace}:${hit.page}`}
              ref={leaveRow}
              type="button"
              className={`n-palette-row${i === active ? " is-active" : ""}`}
              data-testid="search-result"
              onMouseMove={() => setActive(i)}
              onClick={(e) => open(hit, e.metaKey)}
            >
              <span className="n-row-icon">
                <PageIcon icon={hit.icon} />
              </span>
              <span className="n-palette-text">
                <span className="n-palette-title">
                  <Highlight text={hit.title} query={query} />
                  {hit.path.length ? <span className="n-palette-path"> — {hit.path.join(" / ")}</span> : null}
                </span>
                {hit.snippet && hits ? (
                  <span className="n-palette-detail">
                    <Highlight text={hit.snippet} query={query} />
                  </span>
                ) : null}
              </span>
              <span className="n-palette-time">{relativeTime(hit.updatedAt, now)}</span>
              {i === active ? <Icon name="enter" size={14} className="n-palette-enter" /> : null}
            </button>
          ))}
        </div>
        <div className="n-palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Select
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>⌘</kbd>
            <kbd>↵</kbd> Open in new tab
          </span>
        </div>
      </div>
    </div>
  );
}
