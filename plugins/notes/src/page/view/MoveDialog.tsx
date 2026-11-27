import { useEffect, useMemo, useState } from "react";
import { exitRef } from "../ui/motion";
import { allPages, ancestorsOf, displayTitle, getPage, isArchivedDeep } from "../../shared/model";
import { useApp, type PageRef } from "../app/context";
import { fuzzyScore } from "../editor/SlashMenu";
import { Icon, PageIcon } from "../ui/icons";
import { toast } from "../ui/toast";
import { WorkspaceTile } from "../sidebar/WorkspaceMenu";

type Target = { key: string; workspace: string; parent: string; title: string; icon: React.ReactNode; detail: string };

export function MoveDialog({ target, onClose }: { target: PageRef; onClose: () => void }) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const targets = useMemo(() => {
    const out: Target[] = [];
    for (const w of app.workspaces.filter((x) => !x.pageShare)) out.push({ key: `ws-${w.id}`, workspace: w.id, parent: "", title: w.shared ? w.name : `${w.name} (Private)`, icon: <WorkspaceTile workspace={w} size={18} />, detail: "Top level" });
    for (const [workspace, tree] of app.trees) {
      const blocked = new Set<string>([target.page]);
      for (const p of allPages(tree)) {
        if (isArchivedDeep(tree, p.id) || p.kind !== "page" || p.isTemplate || p.sharedIn) continue;
        if (workspace === target.workspace && (blocked.has(p.id) || ancestorsOf(tree, p.id).some((a) => a.id === target.page))) continue;
        out.push({ key: p.id, workspace, parent: p.id, title: displayTitle(p), icon: <PageIcon icon={p.icon} />, detail: ancestorsOf(tree, p.id).map((a) => displayTitle(a)).join(" / ") });
      }
    }
    return out;
  }, [app.trees, app.workspaces, target]);
  const shown = query ? targets.map((t) => ({ t, s: fuzzyScore(query, { title: t.title }) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t) : targets;
  useEffect(() => setActive(0), [query]);
  const pick = async (t: Target) => {
    onClose();
    const moved = await app.move(target, t.parent, undefined, t.workspace === target.workspace ? undefined : t.workspace);
    toast(`Moved to ${t.title}`);
    if (moved && app.route.kind === "page" && app.route.page === target.page) app.openPage(moved.page, { workspace: moved.workspace, replace: true });
  };
  const tree = app.trees.get(target.workspace);
  const meta = tree ? getPage(tree, target.page) : null;
  return (
    <div className="n-modal-scrim" ref={exitRef<HTMLDivElement>("is-modal-leaving")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="n-palette" role="dialog" aria-label="Move page" data-testid="move-dialog">
        <div className="n-palette-input">
          <Icon name="move" />
          <input
            autoFocus
            placeholder={`Move “${meta ? displayTitle(meta) : "page"}” to…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && shown[active]) {
                e.preventDefault();
                void pick(shown[active]!);
              } else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="n-palette-list">
          {shown.slice(0, 60).map((t, i) => (
            <button key={t.key} type="button" className={`n-palette-row${i === active ? " is-active" : ""}`} data-testid="move-target" onMouseEnter={() => setActive(i)} onClick={() => void pick(t)}>
              <span className="n-row-icon">{t.icon}</span>
              <span className="n-palette-text">
                <span className="n-palette-title">{t.title}</span>
                {t.detail ? <span className="n-palette-detail">{t.detail}</span> : null}
              </span>
            </button>
          ))}
          {!shown.length ? <div className="n-menu-empty">No matching pages</div> : null}
        </div>
      </div>
    </div>
  );
}
