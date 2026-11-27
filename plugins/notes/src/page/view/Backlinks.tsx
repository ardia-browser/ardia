import { useEffect, useState } from "react";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { useApp } from "../app/context";
import { useFileIcon } from "../app/files";
import { Icon, PageIcon } from "../ui/icons";

export type BacklinkHit = { page: PageId; title: string; icon: string };

export async function fetchBacklinks(call: (op: string, args: unknown) => Promise<unknown>, workspace: WorkspaceId, page: PageId): Promise<BacklinkHit[]> {
  try {
    const value = await call("backlinks", { workspace, page });
    return Array.isArray(value) ? (value as BacklinkHit[]) : [];
  } catch {
    return [];
  }
}

export function Backlinks({ workspace, page }: { workspace: WorkspaceId; page: PageId }) {
  const app = useApp();
  const [hits, setHits] = useState<BacklinkHit[]>([]);
  const [open, setOpen] = useState(false);
  const resolve = useFileIcon(app.client, workspace);
  useEffect(() => {
    let live = true;
    const load = () => void fetchBacklinks(app.client.call as never, workspace, page).then((h) => live && setHits(h));
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [app.client, workspace, page]);
  if (!hits.length) return null;
  return (
    <div className="n-backlinks" data-testid="backlinks">
      <button type="button" className="n-ghost-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="arrowUpRight" size={14} />
        {hits.length} backlink{hits.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <div className="n-backlinks-list">
          {hits.map((h) => (
            <button key={h.page} type="button" className="n-row" onClick={() => app.openPage(h.page, { workspace })}>
              <span className="n-row-icon">
                <PageIcon icon={h.icon} resolveFile={resolve} />
              </span>
              <span className="n-row-title">{h.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
