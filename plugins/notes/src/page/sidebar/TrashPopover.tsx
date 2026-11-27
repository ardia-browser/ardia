import { useRef, useState } from "react";
import { allPages, ancestorsOf, displayTitle, getPage } from "../../shared/model";
import { useApp } from "../app/context";
import { relativeTime, useTreesVersion } from "../app/hooks";
import { Icon, PageIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { MOTION, useFlip, useLeaveRef } from "../ui/motion";

export function useTrashed() {
  const app = useApp();
  useTreesVersion(app.trees);
  const out: { workspace: string; page: ReturnType<typeof allPages>[number]; path: string }[] = [];
  for (const [workspace, tree] of app.trees) {
    for (const page of allPages(tree)) {
      if (page.deleted || !page.archivedAt) continue;
      const parent = page.parent ? getPage(tree, page.parent) : null;
      if (parent && parent.archivedAt && !parent.deleted) continue;
      out.push({ workspace, page, path: ancestorsOf(tree, page.id).map((a) => displayTitle(a)).join(" / ") });
    }
  }
  return out.sort((a, b) => b.page.archivedAt - a.page.archivedAt);
}

export function TrashList({ compact }: { compact?: boolean }) {
  const app = useApp();
  const trashed = useTrashed();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const shown = trashed.filter((t) => displayTitle(t.page).toLowerCase().includes(query.toLowerCase()));
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, ".n-trash-row[data-page-id]", "data-page-id", [shown.map((t) => t.page.id).join()]);
  const leave = useLeaveRef<HTMLDivElement>((el) => {
    const tree = app.trees.get(el.dataset.workspace ?? "");
    const page = tree ? getPage(tree, el.dataset.pageId ?? "") : null;
    return !!tree && (!page || page.deleted || !page.archivedAt);
  }, "is-row-leaving", MOTION.base);
  return (
    <div className={`n-trash${compact ? " is-compact" : ""}`} data-testid="trash">
      <div className="n-trash-search">
        <div className="n-field">
          <Icon name="search" size={14} />
          <input autoFocus placeholder="Search pages in Trash" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search Trash" />
        </div>
      </div>
      <div className="n-trash-list" ref={listRef}>
        {!shown.length ? (
          <div className="n-empty-note">
            <Icon name="trash" size={22} />
            <div>{query ? "No matches" : "Trash is empty"}</div>
          </div>
        ) : null}
        {shown.map(({ workspace, page, path }) => (
          <div key={page.id} ref={leave} className="n-trash-row" data-testid="trash-row" data-page-id={page.id} data-workspace={workspace} role="button" onClick={() => app.openPage(page.id, { workspace })}>
            <span className="n-row-icon">
              <PageIcon icon={page.icon} />
            </span>
            <span className="n-trash-text">
              <span className="n-row-title">{displayTitle(page)}</span>
              <span className="n-trash-path">{path || app.workspaces.find((w) => w.id === workspace)?.name} · {relativeTime(page.archivedAt)}</span>
            </span>
            <button
              type="button"
              className="n-icon-button"
              title="Restore"
              aria-label="Restore"
              data-testid="trash-restore"
              onClick={(e) => {
                e.stopPropagation();
                void app.restore({ workspace, page: page.id });
              }}
            >
              <Icon name="restore" />
            </button>
            {confirm === page.id ? (
              <button
                type="button"
                className="n-button is-danger is-small"
                data-testid="trash-confirm-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm(null);
                  void app.deleteForever({ workspace, page: page.id });
                }}
              >
                Delete
              </button>
            ) : (
              <button
                type="button"
                className="n-icon-button"
                title="Delete from Trash"
                aria-label="Delete from Trash"
                data-testid="trash-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm(page.id);
                }}
              >
                <Icon name="trash" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="n-trash-foot">Pages in Trash stay until you delete them. Deleting can’t be undone.</div>
    </div>
  );
}

export function TrashPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-end" width={420} maxHeight={520} label="Trash">
      <TrashList compact />
    </Popover>
  );
}
