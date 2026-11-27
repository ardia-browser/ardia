import { useCallback, useEffect, useMemo, useState } from "react";
import { childrenOf, displayTitle, getPage, isArchivedDeep, pagePath, updatePage } from "../../shared/model";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import type { NotesClient } from "../client/types";
import { Sidebar } from "../sidebar/Sidebar";
import { SearchModal } from "../search/SearchModal";
import { MoveDialog } from "../view/MoveDialog";
import { MainView } from "../view/MainView";
import { BootSkeleton } from "../ui/Skeleton";
import { DatabaseHost } from "../database";
import { useDatabaseHost } from "../view/PageBody";
import { Toasts, toast } from "../ui/toast";
import { TemplateGalleryHost } from "../templates/Gallery";
import { AppContext, type AppApi, type PageRef } from "./context";
import { useMe, useNarrow, usePath, usePresence, useStored, useTrees, useWindowStored, useWorkspaces } from "./hooks";
import { parseRoute, withParams } from "./route";
import { ImportSheetHost } from "../import/ImportSheet";
import { OnboardingHost } from "../onboarding/Onboarding";
import { installImageFades } from "../ui/motion";

export function App({ client }: { client: NotesClient }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void client.ready.then(() => setReady(true));
  }, [client]);
  useEffect(() => installImageFades(), []);
  if (!ready) return <BootSkeleton />;
  return <Shell client={client} />;
}

function Shell({ client }: { client: NotesClient }) {
  const me = useMe(client);
  const workspaces = useWorkspaces(client);
  const presence = usePresence(client);
  const path = usePath(client);
  const route = useMemo(() => parseRoute(path), [path]);
  const { trees, synced } = useTrees(client, workspaces);
  const [favorites, setFavorites] = useStored<PageRef[]>("favorites", []);
  const [recents, setRecents] = useStored<PageRef[]>("recents", []);
  const [expanded, setExpandedMap] = useStored<Record<string, boolean>>("expanded", {});
  const [storedSidebarOpen, setStoredSidebarOpen] = useStored("sidebarOpen", true);
  const narrow = useNarrow();
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const sidebarOpen = narrow ? narrowSidebarOpen : storedSidebarOpen;
  const setSidebarOpen = narrow ? setNarrowSidebarOpen : setStoredSidebarOpen;
  const [activeStored, setActiveWorkspace] = useWindowStored("activeWorkspace", "");
  const [search, setSearch] = useState<{ query: string } | null>(null);
  const [moving, setMoving] = useState<PageRef | null>(null);
  const activeWorkspace = workspaces.find((w) => w.id === activeStored && !w.pageShare)?.id ?? workspaces.find((w) => !w.shared)?.id ?? workspaces.find((w) => !w.pageShare)?.id ?? "";

  const workspaceOf = useCallback(
    (page: PageId): WorkspaceId | null => {
      let fallback: WorkspaceId | null = null;
      for (const [id, tree] of trees) {
        const meta = getPage(tree, page);
        if (!meta) continue;
        if (!meta.deleted && !meta.sharedIn) return id;
        fallback ??= id;
      }
      return fallback;
    },
    [trees],
  );

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => client.navigate(to, options), [client]);

  const openPage: AppApi["openPage"] = useCallback(
    (page, options = {}) => {
      const ws = options.workspace ?? workspaceOf(page);
      const tree = ws ? trees.get(ws) : null;
      const meta = tree ? getPage(tree, page) : null;
      const base = meta ? pagePath(meta) : `/${page}`;
      const to = withParams(base, { block: options.block ?? null, p: options.peek ?? null, v: options.view ?? null });
      if (options.newTab) {
        void client.call("openUrl", { url: `ardia://notes${to}` });
        return;
      }
      client.navigate(to, { replace: options.replace });
    },
    [client, trees, workspaceOf],
  );

  const newPage: AppApi["newPage"] = useCallback(
    async (options = {}) => {
      const workspace = options.workspace ?? activeWorkspace;
      if (!workspace) return null;
      const { page } = await client.call("createPage", {
        workspace,
        parent: options.parent ?? "",
        kind: options.kind ?? "page",
        title: options.title,
        icon: options.icon,
        after: options.after,
        props: options.props,
        template: options.template,
      });
      const tree = trees.get(workspace);
      if (tree && options.isTemplate) updatePage(tree, page, { isTemplate: true }, me.deviceId);
      if (options.parent) setExpandedMap((old) => ({ ...old, [`${workspace}:${options.parent}`]: true }));
      if (options.open !== false) {
        const meta = tree ? getPage(tree, page) : null;
        client.navigate(meta ? pagePath(meta) : `/Untitled-${page}`);
      }
      return { workspace, page };
    },
    [client, activeWorkspace, trees, me.deviceId],
  );

  const archive: AppApi["archive"] = useCallback(
    async (ref) => {
      await client.call("archivePage", ref);
      const tree = trees.get(ref.workspace);
      const title = tree ? displayTitle(getPage(tree, ref.page)) : "Page";
      toast(`Moved “${title}” to Trash`, { label: "Undo", run: () => void client.call("restorePage", ref) });
      if (route.kind === "page" && tree && isArchivedDeep(tree, route.page) && route.page !== ref.page) openPage(ref.page);
    },
    [client, trees, route, openPage],
  );

  const api: AppApi = {
    client,
    me,
    workspaces,
    trees,
    presence,
    route,
    activeWorkspace,
    setActiveWorkspace,
    workspaceOf,
    treeOf: (id) => trees.get(id) ?? null,
    openPage,
    navigate,
    newPage,
    archive,
    restore: async (ref) => {
      await client.call("restorePage", ref);
    },
    deleteForever: async (ref) => {
      await client.call("deletePage", ref);
      setFavorites((old) => old.filter((f) => f.page !== ref.page));
    },
    duplicate: async (ref) => {
      const { page } = await client.call("duplicatePage", ref);
      return { workspace: ref.workspace, page };
    },
    move: async (ref, parent, after, toWorkspace) => {
      const result = await client.call("movePage", { workspace: ref.workspace, page: ref.page, parent, after, toWorkspace });
      if (parent) setExpandedMap((old) => ({ ...old, [`${result.workspace}:${parent}`]: true }));
      return result;
    },
    favorites,
    isFavorite: (page) => favorites.some((f) => f.page === page),
    toggleFavorite: (ref) => setFavorites((old) => (old.some((f) => f.page === ref.page) ? old.filter((f) => f.page !== ref.page) : [...old, ref])),
    recents,
    expanded,
    setExpanded: (key, open) => setExpandedMap((old) => ({ ...old, [key]: open })),
    openSearch: (query = "") => setSearch({ query }),
    sidebarOpen,
    toggleSidebar: () => setSidebarOpen((o) => !o),
    copyLink: (ref) => {
      const tree = trees.get(ref.workspace);
      const meta = tree ? getPage(tree, ref.page) : null;
      void navigator.clipboard?.writeText(`ardia://notes${meta ? pagePath(meta) : `/${ref.page}`}`).catch(() => {});
      toast("Copied link to page");
    },
    moveDialog: (ref) => setMoving(ref),
  };

  useEffect(() => setNarrowSidebarOpen(false), [path]);

  const viewingWorkspace = route.kind === "page" ? workspaceOf(route.page) : null;
  const viewingInfo = workspaces.find((w) => w.id === viewingWorkspace);
  const sidebarWorkspace = viewingInfo?.pageShare ? viewingInfo.pageShare.home : viewingWorkspace;
  useEffect(() => {
    if (sidebarWorkspace && sidebarWorkspace !== activeWorkspace) setActiveWorkspace(sidebarWorkspace);
  }, [sidebarWorkspace]);
  useEffect(() => {
    client.viewing(viewingWorkspace, route.kind === "page" && viewingWorkspace ? route.page : null);
  }, [client, viewingWorkspace, route.kind === "page" ? route.page : null]);

  useEffect(() => {
    if (route.kind !== "page") return;
    const ws = workspaceOf(route.page);
    if (!ws) return;
    try {
      localStorage.setItem("notes:last", route.page);
    } catch {}
    setRecents((old) => [{ workspace: ws, page: route.page }, ...old.filter((r) => r.page !== route.page)].slice(0, 20));
  }, [route.kind === "page" ? route.page : null, workspaceOf]);

  useEffect(() => {
    if (route.kind !== "root" || !synced) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem("notes:last");
    } catch {}
    const ws = last ? workspaceOf(last) : null;
    const tree = ws ? trees.get(ws) : null;
    if (last && tree && !isArchivedDeep(tree, last)) return openPage(last, { replace: true });
    const first = trees.get(activeWorkspace);
    const top = first ? childrenOf(first, "").find((p) => !p.isTemplate) : null;
    if (top) openPage(top.id, { workspace: activeWorkspace, replace: true });
    else navigate("/home", { replace: true });
  }, [route.kind, synced]);

  useEffect(() => {
    if (route.kind === "search") setSearch({ query: route.query });
  }, [route.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && (event.key === "k" || event.key === "p")) {
        if (event.key === "k" && (event.target as HTMLElement | null)?.closest?.(".bn-editor") && window.getSelection()?.toString()) return;
        event.preventDefault();
        setSearch((s) => (s ? null : { query: "" }));
      } else if (mod && event.key === "\\") {
        event.preventDefault();
        setSidebarOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (route.kind === "trash") client.setTitle("Trash");
    else if (route.kind === "settings") client.setTitle("Settings");
    else if (route.kind === "home") client.setTitle("Home");
    else if (route.kind === "search") client.setTitle("Search");
    else if (route.kind === "missing") client.setTitle("Page not found");
  }, [route.kind, client]);

  return (
    <AppContext value={api}>
      <AppDatabaseHost workspace={activeWorkspace}>
      <div className={`n-app${sidebarOpen ? "" : " is-collapsed"}`}>
        <Sidebar />
        <MainView synced={synced} />
      </div>
      {search ? (
        <SearchModal
          initialQuery={search.query}
          onClose={() => {
            setSearch(null);
            if (route.kind === "search") history.length > 1 ? history.back() : navigate("/home", { replace: true });
          }}
        />
      ) : null}
      {moving ? <MoveDialog target={moving} onClose={() => setMoving(null)} /> : null}
      <ImportSheetHost />
      <OnboardingHost synced={synced} />
      <TemplateGalleryHost />
      <Toasts />
      </AppDatabaseHost>
    </AppContext>
  );
}

function AppDatabaseHost({ workspace, children }: { workspace: WorkspaceId; children: React.ReactNode }) {
  const value = useDatabaseHost(workspace);
  return <DatabaseHost value={value}>{children}</DatabaseHost>;
}
