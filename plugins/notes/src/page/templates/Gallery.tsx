import { useEffect, useMemo, useRef, useState } from "react";
import { VIEW_TYPES, type ViewType } from "../../shared/database";
import { allPages, displayTitle, getPage, isArchivedDeep } from "../../shared/model";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { searchTemplates, TEMPLATE_CATEGORIES, TEMPLATE_SUMMARIES, type TemplateCategory, type TemplateSummary } from "../../shared/templates";
import { useApp } from "../app/context";
import { useTreesVersion } from "../app/hooks";
import { Icon, PageIcon } from "../ui/icons";
import { Menu } from "../ui/Menu";
import { exitRef } from "../ui/motion";
import { toast } from "../ui/toast";
import { coverValue } from "../view/covers";
import { applyBuiltIn, applyYours, count, type UseTarget } from "./actions";
import { closeGallery, useGalleryRequest, type GalleryRequest } from "./store";
import { previewKey, TemplatePreview, type PreviewSource } from "./TemplatePreview";
import "./gallery.css";

type Section = "all" | "yours" | "rows" | TemplateCategory;
type Own = { workspace: WorkspaceId; id: PageId; title: string; icon: string; cover: string; row: boolean };
type Choice = { kind: "builtin"; summary: TemplateSummary } | { kind: "own"; own: Own };
type TargetKind = "here" | "child" | "top";

const VIEW_ICONS: Record<ViewType, string> = { table: "table", board: "board", list: "list", gallery: "gallery", calendar: "calendar", timeline: "timeline", chart: "chart", form: "form" };
const viewLabel = (type: ViewType) => VIEW_TYPES.find((v) => v.type === type)?.label ?? type;

export function TemplateGalleryHost() {
  const request = useGalleryRequest();
  if (!request) return null;
  return <Gallery key={`${request.source}:${request.rows?.database ?? ""}:${request.into ?? ""}:${request.template ?? ""}`} request={request} />;
}

function useOwnTemplates(): Own[] {
  const app = useApp();
  const version = useTreesVersion(app.trees);
  return useMemo(() => {
    const out: Own[] = [];
    for (const [workspace, tree] of app.trees)
      for (const meta of allPages(tree)) {
        if (!meta.isTemplate || isArchivedDeep(tree, meta.id)) continue;
        if (meta.parent && getPage(tree, meta.parent)?.kind === "database") continue;
        out.push({ workspace, id: meta.id, title: displayTitle(meta), icon: meta.icon, cover: meta.cover, row: false });
      }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }, [app.trees, version]);
}

function Gallery({ request }: { request: GalleryRequest }) {
  const app = useApp();
  const own = useOwnTemplates();
  const rows = request.rows;
  const rowTemplates: Own[] = useMemo(() => (rows ? rows.templates.map((t) => ({ workspace: rows.workspace, id: t.id, title: t.title || "Untitled", icon: t.icon, cover: "", row: true })) : []), [rows]);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>(request.category ?? (rows ? "rows" : "all"));
  const [choice, setChoice] = useState<Choice | null>(() => {
    const found = request.template ? TEMPLATE_SUMMARIES.find((t) => t.id === request.template) : null;
    return found ? { kind: "builtin", summary: found } : null;
  });
  const search = useRef<HTMLInputElement>(null);
  const searched = useRef(false);

  useEffect(() => {
    count(app, `template_gallery_opens_${request.source}`);
  }, []);

  const builtins = useMemo(() => {
    if (section === "yours" || section === "rows") return [];
    const list = searchTemplates(query, section === "all" ? null : section);
    return rows ? list.filter((t) => t.kind === "page") : list;
  }, [query, section, rows]);
  const q = query.trim().toLowerCase();
  const ownShown = section === "all" || section === "yours" ? own.filter((t) => !q || t.title.toLowerCase().includes(q)) : [];
  const rowShown = rows && (section === "all" || section === "rows") ? rowTemplates.filter((t) => !q || t.title.toLowerCase().includes(q)) : [];

  useEffect(() => {
    if (q && !searched.current) {
      searched.current = true;
      count(app, "template_searches");
    }
  }, [q]);

  const pick = (next: Choice) => {
    setChoice(next);
    count(app, "template_previews");
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".n-popover, [data-testid='db-peek-layer']")) return;
      event.preventDefault();
      if (choice) setChoice(null);
      else closeGallery();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choice]);

  useEffect(() => {
    if (!choice) search.current?.focus();
  }, [choice]);

  const sections: { id: Section; label: string; icon: React.ReactNode; count: number }[] = [
    ...(rows ? [{ id: "rows" as Section, label: `${rows.title || "Untitled"}`, icon: <Icon name="database" size={15} />, count: rowTemplates.length }] : []),
    { id: "all", label: "All templates", icon: <Icon name="template" size={15} />, count: (rows ? TEMPLATE_SUMMARIES.filter((t) => t.kind === "page").length : TEMPLATE_SUMMARIES.length) + own.length + rowTemplates.length },
    { id: "yours", label: "Your templates", icon: <Icon name="starFilled" size={15} />, count: own.length },
    ...TEMPLATE_CATEGORIES.map((c) => ({ id: c.id as Section, label: c.name, icon: <span className="n-gallery-nav-emoji">{c.icon}</span>, count: TEMPLATE_SUMMARIES.filter((t) => t.category === c.id && (!rows || t.kind === "page")).length })),
  ];

  const heading = section === "all" ? (rows ? `Templates for ${rows.title || "Untitled"}` : "Templates") : section === "yours" ? "Your templates" : section === "rows" ? `${rows?.title || "Untitled"} templates` : TEMPLATE_CATEGORIES.find((c) => c.id === section)!.name;
  const blurb = section === "all" ? (rows ? "Start a new row from one of this database's templates, or from any page template." : "Start from something good. Every template is yours to change.") : section === "yours" ? "Pages you saved as templates. Save any page from its ••• menu." : section === "rows" ? "Row templates belong to this database. Make a new one from the New menu." : TEMPLATE_CATEGORIES.find((c) => c.id === section)!.blurb;
  const nothing = !builtins.length && !ownShown.length && !rowShown.length;

  return (
    <div className="n-modal-scrim n-gallery-scrim" ref={exitRef<HTMLDivElement>("is-modal-leaving")} onMouseDown={(e) => e.target === e.currentTarget && closeGallery()}>
      <div className="n-gallery" role="dialog" aria-modal="true" aria-label="Templates" data-testid="template-gallery">
        <aside className="n-gallery-side">
          <label className="n-gallery-search">
            <Icon name="search" size={14} />
            <input
              ref={search}
              value={query}
              placeholder="Search templates"
              aria-label="Search templates"
              data-testid="template-search"
              onChange={(e) => {
                setQuery(e.target.value);
                setChoice(null);
                if (e.target.value && section !== "all") setSection("all");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const first = rowShown[0] ?? ownShown[0];
                  if (builtins[0]) pick({ kind: "builtin", summary: builtins[0] });
                  else if (first) pick({ kind: "own", own: first });
                }
              }}
            />
          </label>
          <nav className="n-gallery-nav" aria-label="Template categories">
            {sections.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`n-gallery-nav-row${section === s.id ? " is-selected" : ""}${i === (rows ? 2 : 1) ? " has-gap" : ""}`}
                aria-current={section === s.id ? "true" : undefined}
                data-testid={`template-section-${s.id}`}
                onClick={() => {
                  setSection(s.id);
                  setChoice(null);
                }}
              >
                <span className="n-gallery-nav-icon">{s.icon}</span>
                <span className="n-gallery-nav-label">{s.label}</span>
                <span className="n-gallery-nav-count">{s.count}</span>
              </button>
            ))}
          </nav>
        </aside>
        <section className="n-gallery-main">
          {choice ? (
            <Detail choice={choice} request={request} onBack={() => setChoice(null)} />
          ) : (
            <div className="n-gallery-browse" data-testid="template-grid">
              <header className="n-gallery-head">
                <div className="n-gallery-head-text">
                  <h2 className="n-gallery-title">{q ? `Results for “${query.trim()}”` : heading}</h2>
                  <p className="n-gallery-blurb">{blurb}</p>
                </div>
                <button type="button" className="n-icon-button n-close-button" aria-label="Close" data-testid="template-gallery-close" onClick={closeGallery}>
                  <Icon name="x" size={14} />
                </button>
              </header>
              <div className="n-gallery-scroll">
                {nothing ? (
                  <div className="n-empty-note" data-testid="template-empty">
                    {section === "yours" && !q ? "No templates of your own yet. Open any page’s ••• menu and choose Save as template." : section === "rows" && !q ? "This database has no templates yet." : "Nothing matches that search."}
                  </div>
                ) : null}
                {rowShown.length ? (
                  <Cards title={section === "all" ? `${rows?.title || "Untitled"} templates` : null}>
                    {rowShown.map((t) => (
                      <OwnCard key={t.id} own={t} onOpen={() => pick({ kind: "own", own: t })} />
                    ))}
                  </Cards>
                ) : null}
                {ownShown.length ? (
                  <Cards title={section === "all" ? "Your templates" : null}>
                    {ownShown.map((t) => (
                      <OwnCard key={t.id} own={t} onOpen={() => pick({ kind: "own", own: t })} />
                    ))}
                  </Cards>
                ) : null}
                {builtins.length ? (
                  <Cards title={section === "all" && (ownShown.length || rowShown.length) ? "Built in" : null}>
                    {builtins.map((t) => (
                      <TemplateCard key={t.id} summary={t} onOpen={() => pick({ kind: "builtin", summary: t })} />
                    ))}
                  </Cards>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Cards({ title, children }: { title: string | null; children: React.ReactNode }) {
  return (
    <div className="n-gallery-group">
      {title ? <div className="n-gallery-group-title">{title}</div> : null}
      <div className="n-gallery-cards">{children}</div>
    </div>
  );
}

function Cover({ cover, icon }: { cover: string; icon: string }) {
  const background = coverValue(cover);
  return (
    <span className="n-gallery-cover" style={background ? { background } : undefined}>
      <span className="n-gallery-card-icon">
        <PageIcon icon={icon} size={22} fallback="template" />
      </span>
    </span>
  );
}

function TemplateCard({ summary, onOpen }: { summary: TemplateSummary; onOpen: () => void }) {
  return (
    <button type="button" className="n-gallery-card" data-testid="template-card" data-template={summary.id} onClick={onOpen}>
      <Cover cover={summary.cover} icon={summary.icon} />
      <span className="n-gallery-card-body">
        <span className="n-gallery-card-title">{summary.title}</span>
        <span className="n-gallery-card-desc">{summary.description}</span>
        <span className="n-gallery-card-meta">
          {summary.views.slice(0, 5).map((v) => (
            <span key={v} className="n-gallery-chip" title={viewLabel(v)}>
              <Icon name={VIEW_ICONS[v]} size={12} />
            </span>
          ))}
          {summary.databases ? <span className="n-gallery-card-count">{summary.databases === 1 ? "1 database" : `${summary.databases} databases`}</span> : <span className="n-gallery-card-count">Page</span>}
        </span>
      </span>
    </button>
  );
}

function OwnCard({ own, onOpen }: { own: Own; onOpen: () => void }) {
  return (
    <button type="button" className="n-gallery-card is-own" data-testid={own.row ? "template-row-card" : "template-own-card"} data-page={own.id} onClick={onOpen}>
      <Cover cover={own.cover.startsWith("file:") ? "" : own.cover} icon={own.icon} />
      <span className="n-gallery-card-body">
        <span className="n-gallery-card-title">{own.title}</span>
        <span className="n-gallery-card-desc">{own.row ? "A template for new rows in this database." : "Saved from one of your pages."}</span>
      </span>
    </button>
  );
}

function Detail({ choice, request, onBack }: { choice: Choice; request: GalleryRequest; onBack: () => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const rows = request.rows;
  const workspace = request.workspace ?? rows?.workspace ?? app.activeWorkspace;
  const tree = app.trees.get(workspace) ?? null;
  const routePage = app.route.kind === "page" ? app.route.page : null;
  const parentId = request.parent ?? (routePage && tree && getPage(tree, routePage)?.kind === "page" && !getPage(tree, routePage)?.isTemplate ? routePage : null);
  const parentMeta = parentId && tree ? getPage(tree, parentId) : null;
  const wsName = app.workspaces.find((w) => w.id === workspace)?.name ?? "this workspace";
  const isDbRoot = choice.kind === "builtin" && choice.summary.kind === "database";
  const childTarget = parentMeta ? { id: "child" as TargetKind, label: displayTitle(parentMeta), detail: "As a subpage" } : null;
  const targets: { id: TargetKind; label: string; detail: string }[] = rows
    ? []
    : [
        ...(request.into ? [{ id: "here" as TargetKind, label: "This page", detail: "Added into the page you're on" }] : []),
        ...(request.parent && childTarget && parentId !== request.into ? [childTarget] : []),
        { id: "top" as TargetKind, label: wsName, detail: "As a new page in the sidebar" },
        ...(!request.parent && childTarget ? [childTarget] : []),
      ];
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState<TargetKind>(targets[0]?.id ?? "top");
  const source: PreviewSource = choice.kind === "builtin" ? { kind: "builtin", id: choice.summary.id } : { kind: "page", workspace: choice.own.workspace, page: choice.own.id, row: choice.own.row };
  const title = choice.kind === "builtin" ? choice.summary.title : choice.own.title;
  const description = choice.kind === "builtin" ? choice.summary.description : choice.own.row ? `A template for new rows in ${rows?.title || "this database"}.` : "One of your own templates. Using it makes a copy; the template stays as it is.";

  const use = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (rows) {
        if (choice.kind === "own" && choice.own.row) {
          await rows.useRowTemplate(choice.own.id);
          count(app, "template_uses_row");
          closeGallery();
          return;
        }
        const made = choice.kind === "builtin" ? await applyBuiltIn(app, choice.summary.id, { workspace: rows.workspace, parent: rows.database }) : await applyYours(app, { workspace: choice.own.workspace, page: choice.own.id }, { workspace: rows.workspace, parent: rows.database });
        if (choice.kind === "own") count(app, "template_uses_yours");
        closeGallery();
        rows.openRow(made.page);
        return;
      }
      const to: UseTarget = target === "here" && request.into ? { workspace, into: request.into } : target === "child" && parentId ? { workspace, parent: parentId } : { workspace };
      const made = choice.kind === "builtin" ? await applyBuiltIn(app, choice.summary.id, to) : await applyYours(app, { workspace: choice.own.workspace, page: choice.own.id }, to);
      if (choice.kind === "own") count(app, "template_uses_yours");
      closeGallery();
      app.openPage(made.page, { workspace: made.workspace });
      toast(`Added “${title}”`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void use();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="n-gallery-detail" data-testid="template-detail" data-template={choice.kind === "builtin" ? choice.summary.id : choice.own.id}>
      <header className="n-gallery-detail-head">
        <button type="button" className="n-gallery-back" data-testid="template-back" onClick={onBack}>
          <Icon name="chevronLeft" size={14} />
          Templates
        </button>
        <span className="n-spacer" />
        {targets.length > 1 ? (
          <button type="button" className="n-gallery-addto" data-testid="template-add-to" data-target={target} aria-haspopup="menu" onClick={(e) => setPicker(e.currentTarget)}>
            <span className="n-gallery-addto-label">Add to</span>
            <span className="n-gallery-addto-value">{targets.find((t) => t.id === target)?.label}</span>
            <Icon name="chevronDown" size={10} />
          </button>
        ) : null}
        {picker ? (
          <Menu
            anchor={picker}
            placement="bottom-end"
            width={260}
            onClose={() => setPicker(null)}
            entries={targets.map((t) => ({
              id: `template-target-${t.id}`,
              label: t.label,
              detail: t.detail,
              icon: t.id === "top" ? "sidebar" : t.id === "child" && parentMeta ? <PageIcon icon={parentMeta.icon} size={16} /> : "page",
              checked: target === t.id,
              onSelect: () => setTarget(t.id),
            }))}
          />
        ) : null}
        <button type="button" className="n-button is-primary n-gallery-use" data-testid="template-use" disabled={busy} title="⌘↩" onClick={() => void use()}>
          {rows ? "New row from template" : isDbRoot && target === "here" ? "Add to this page" : "Use this template"}
        </button>
        <button type="button" className="n-icon-button n-close-button" aria-label="Close" onClick={closeGallery}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="n-gallery-detail-intro">
        <h2 className="n-gallery-detail-title">{title}</h2>
        <p className="n-gallery-blurb">{description}</p>
        {choice.kind === "builtin" && choice.summary.views.length ? (
          <div className="n-gallery-detail-views">
            {choice.summary.views.map((v) => (
              <span key={v} className="n-gallery-view-chip">
                <Icon name={VIEW_ICONS[v]} size={13} />
                {viewLabel(v)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="n-gallery-preview" data-testid="template-preview-frame">
        <div className="n-gallery-preview-label">Preview</div>
        <TemplatePreview key={previewKey(source)} source={source} />
      </div>
    </div>
  );
}
