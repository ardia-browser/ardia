import { displayTitle, getPage, isArchivedDeep } from "../../shared/model";
import { useApp } from "../app/context";
import { useFileIcon } from "../app/files";
import { relativeTime, useNow, useTreesVersion } from "../app/hooks";
import { Icon, PageIcon } from "../ui/icons";
import { coverStyle } from "./covers";
import { SimpleTopbar } from "./MainView";
import { useTemplates } from "../sidebar/TemplatesPopover";
import { ImportEmptyState } from "../import/ImportEmptyState";
import { TEMPLATE_SUMMARIES } from "../../shared/templates";
import { openGallery } from "../templates/store";

const FEATURED_TEMPLATES = ["journal", "project-tracker", "meeting-notes", "reading-list"].map((id) => TEMPLATE_SUMMARIES.find((t) => t.id === id)).filter((t) => !!t);

function greeting(now: number) {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView() {
  const app = useApp();
  useTreesVersion(app.trees);
  const now = useNow();
  const resolveIcon = useFileIcon(app.client, app.activeWorkspace);
  const templates = useTemplates();
  const recents = app.recents
    .filter((r) => r.workspace === app.activeWorkspace)
    .map((r) => {
      const tree = app.trees.get(r.workspace);
      const meta = tree ? getPage(tree, r.page) : null;
      return meta && tree && !isArchivedDeep(tree, r.page) ? { ...r, meta } : null;
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .slice(0, 8);
  return (
    <div className="n-main-col is-entering">
      <SimpleTopbar title="Home" icon="home" />
      <div className="n-scroller">
        <div className="n-home" data-testid="home">
          <h1 className="n-home-greeting">
            {greeting(now)}
            {app.me.name ? `, ${app.me.name.split(" ")[0]}` : ""}
          </h1>
          <ImportEmptyState />
          <section className="n-home-section">
            <div className="n-home-label">
              <Icon name="clock" size={14} />
              Recently visited
            </div>
            <div className="n-home-cards">
              {recents.map((r) => (
                <button key={r.page} type="button" className="n-home-card" onClick={() => app.openPage(r.page, { workspace: r.workspace })}>
                  <span className="n-home-card-cover" style={coverStyle(r.meta.cover, null)} />
                  <span className="n-home-card-icon">
                    <PageIcon icon={r.meta.icon} size={26} resolveFile={resolveIcon} />
                  </span>
                  <span className="n-home-card-title">{displayTitle(r.meta)}</span>
                  <span className="n-home-card-time">{relativeTime(r.meta.updatedAt, now)}</span>
                </button>
              ))}
              <button type="button" className="n-home-card is-new" onClick={() => void app.newPage()}>
                <span className="n-home-card-icon">
                  <Icon name="plus" size={22} />
                </span>
                <span className="n-home-card-title">New page</span>
              </button>
            </div>
          </section>
          <section className="n-home-section" data-testid="home-templates">
            <div className="n-home-label">
              <Icon name="template" size={14} />
              Start from a template
            </div>
            <div className="n-home-list">
              {templates.map((t) => (
                <button key={t.id} type="button" className="n-row" onClick={() => void app.newPage({ workspace: t.workspace, template: t.id })}>
                  <span className="n-row-icon">
                    <PageIcon icon={t.icon} />
                  </span>
                  <span className="n-row-title">{t.title}</span>
                </button>
              ))}
              {FEATURED_TEMPLATES.map((t) => (
                <button key={t.id} type="button" className="n-row" data-testid="home-featured-template" onClick={() => openGallery({ source: "home", workspace: app.activeWorkspace, template: t.id })}>
                  <span className="n-row-icon">
                    <PageIcon icon={t.icon} />
                  </span>
                  <span className="n-row-title">{t.title}</span>
                </button>
              ))}
              <button type="button" className="n-row" data-testid="home-browse-templates" onClick={() => openGallery({ source: "home", workspace: app.activeWorkspace })}>
                <span className="n-row-icon">
                  <Icon name="arrowRight" />
                </span>
                <span className="n-row-title">Browse all templates</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
