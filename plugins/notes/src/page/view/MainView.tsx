import { useEffect, useState } from "react";
import { getPage } from "../../shared/model";
import { useApp } from "../app/context";
import { useTreesVersion } from "../app/hooks";
import { Icon } from "../ui/icons";
import { PageSkeleton } from "../ui/Skeleton";
import { HomeView } from "./HomeView";
import { PageView } from "./PageView";
import { SettingsView } from "./SettingsView";
import { TrashList } from "../sidebar/TrashPopover";

export function SimpleTopbar({ title, icon }: { title: string; icon?: string }) {
  const app = useApp();
  return (
    <header className="n-topbar">
      {!app.sidebarOpen ? (
        <button type="button" className="n-icon-button" aria-label="Open sidebar" title="Open sidebar (⌘\)" onClick={app.toggleSidebar}>
          <Icon name="sidebar" />
        </button>
      ) : null}
      <div className="n-crumbs">
        <span className="n-crumb is-static">
          {icon ? <Icon name={icon} size={14} /> : null}
          {title}
        </span>
      </div>
    </header>
  );
}

export function NotFound({ message = "This page doesn’t exist" }: { message?: string }) {
  const app = useApp();
  return (
    <div className="n-main-col is-entering">
      <SimpleTopbar title="Page not found" />
      <div className="n-notfound" data-testid="not-found">
        <div className="n-notfound-icon">
          <Icon name="pageEmpty" size={40} strokeWidth={1.1} />
        </div>
        <h1>{message}</h1>
        <p className="n-muted">It may have been deleted, or the link is wrong. If it’s in a shared workspace, it may not have synced yet.</p>
        <button type="button" className="n-button is-primary" onClick={() => app.navigate("/home")}>
          Back to Home
        </button>
      </div>
    </div>
  );
}

function ResolvingPage({ page }: { page: string }) {
  const app = useApp();
  const [state, setState] = useState<"resolving" | "missing">("resolving");
  useEffect(() => {
    let live = true;
    setState("resolving");
    void app.client
      .call("resolve", { path: app.client.path() })
      .then((hit) => {
        if (!live) return;
        if (!hit) setState("missing");
      })
      .catch(() => live && setState("missing"));
    return () => {
      live = false;
    };
  }, [page]);
  if (state === "missing") return <NotFound />;
  return <div className="n-main-col"><PageSkeleton /></div>;
}

export function MainView({ synced }: { synced: boolean }) {
  const app = useApp();
  useTreesVersion(app.trees);
  const route = app.route;
  let content: React.ReactNode;
  if (route.kind === "page") {
    const ws = app.workspaceOf(route.page);
    const tree = ws ? app.trees.get(ws) : null;
    const meta = tree ? getPage(tree, route.page) : null;
    const share = meta?.sharedIn ? app.workspaces.find((w) => w.id === meta.sharedIn) : null;
    if (meta && !meta.deleted && meta.sharedIn) content = share && share.state !== "missing" ? <div className="n-main-col"><PageSkeleton /></div> : <NotFound message="This shared page isn’t available" />;
    else if (ws && tree && meta && !meta.deleted) content = <PageView key={`${ws}:${route.page}`} workspace={ws} page={route.page} />;
    else if (!synced) content = <div className="n-main-col"><PageSkeleton /></div>;
    else if (meta?.deleted) content = <NotFound message="This page was deleted" />;
    else content = <ResolvingPage page={route.page} />;
  } else if (route.kind === "home" || route.kind === "search" || route.kind === "root") content = <HomeView />;
  else if (route.kind === "trash")
    content = (
      <div className="n-main-col is-entering">
        <SimpleTopbar title="Trash" icon="trash" />
        <div className="n-scroller">
          <div className="n-narrow">
            <h1 className="n-view-title">Trash</h1>
            <TrashList />
          </div>
        </div>
      </div>
    );
  else if (route.kind === "settings") content = <SettingsView />;
  else content = <NotFound />;
  return <main className="n-main">{content}</main>;
}
