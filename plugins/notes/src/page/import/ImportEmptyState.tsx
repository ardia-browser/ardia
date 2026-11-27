import { allPages, isArchivedDeep } from "../../shared/model";
import { useApp } from "../app/context";
import { useTreesVersion } from "../app/hooks";
import { FEATURED_SOURCES, importSource } from "../../shared/importSources";
import { SourceIcon } from "./ImportSources";
import { openImportSheet } from "./importSheetStore";
import "./import.css";

export function useWorkspaceEmpty(workspace: string): boolean {
  const app = useApp();
  useTreesVersion(app.trees);
  const tree = app.trees.get(workspace);
  if (!tree) return false;
  return !allPages(tree).some((p) => !p.deleted && !p.isTemplate && !isArchivedDeep(tree, p.id));
}

export function ImportEmptyState() {
  const app = useApp();
  const empty = useWorkspaceEmpty(app.activeWorkspace);
  if (!empty) return null;
  return (
    <section className="n-imp-empty" data-testid="import-empty">
      <div className="n-ob-eyebrow">An empty workspace</div>
      <h2 className="n-ob-title is-small">Start writing, or bring your notes</h2>
      <p className="n-imp-lede">Notion, Obsidian, Evernote and Apple Notes come in with their pages, links and attachments.</p>
      <div className="n-imp-empty-row">
        <span className="n-imp-empty-marks" aria-hidden="true">
          {FEATURED_SOURCES.map((id) => importSource(id)).map((s) => (s ? <SourceIcon key={s.id} source={s} size={26} /> : null))}
        </span>
        <button type="button" className="n-ob-primary" onClick={() => openImportSheet()} data-testid="import-empty-open">
          Import…
        </button>
        <button type="button" className="n-ob-link" onClick={() => void app.newPage()}>
          New page
        </button>
      </div>
    </section>
  );
}
