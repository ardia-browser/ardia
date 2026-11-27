import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { allPages, childrenOf, displayTitle, getPage, isArchivedDeep, isLive, isShareLink } from "../../shared/model";
import type { PageId, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";
import { useApp, type PageRef } from "../app/context";
import { useFileIcon } from "../app/files";
import { useStored, useTreesVersion, useTreeVersion } from "../app/hooks";
import { animateHeight, exitRef, MOTION, useClosingFocus, useFlip, useLeaveRef, usePresence } from "../ui/motion";
import { Icon, PageIcon } from "../ui/icons";
import { Menu, type MenuEntry } from "../ui/Menu";
import { TrashPopover } from "./TrashPopover";
import { openGallery } from "../templates/store";
import { WorkspaceMenu, WorkspaceTile } from "./WorkspaceMenu";
import { RenamePopover } from "./RenamePopover";
import { openImportSheet } from "../import/importSheetStore";
import { toast } from "../ui/toast";

const MIN = 200;
const MAX = 480;
const DRAG_TYPE = "application/x-ardia-notes-page";

type DropZone = "before" | "inside" | "after";

let dragging: PageRef | null = null;

const livePages = new Map<string, { version: string; ids: Set<PageId> }>();
let freshPages = new Set<PageId>();

function noteFreshPages(trees: Map<WorkspaceId, Y.Doc>, version: string) {
  for (const [workspace, tree] of trees) {
    const known = livePages.get(workspace);
    if (known?.version === version) continue;
    const ids = new Set(allPages(tree).filter(isLive).map((p) => p.id));
    if (known) for (const id of ids) if (!known.ids.has(id)) freshPages.add(id);
    livePages.set(workspace, { version, ids });
  }
}

const isFreshRow = (el: HTMLElement) => freshPages.has(el.getAttribute("data-page-id") ?? "") || el.classList.contains("n-section-head");

const workspaceTreeExit = exitRef<HTMLDivElement>("is-ws-leaving", MOTION.fast);

export function Sidebar() {
  const app = useApp();
  const [width, setWidth] = useStored("sidebarWidth", 240);
  const scrollRef = useRef<HTMLDivElement>(null);
  const treesVersion = useTreesVersion(app.trees);
  const [panel, setPanel] = useState<{ kind: "trash" | "workspace"; el: HTMLElement } | null>(null);
  const [sections, setSections] = useStored<Record<string, boolean>>("sections", {});
  const resizing = useRef(false);
  noteFreshPages(app.trees, treesVersion);
  useFlip(scrollRef, "[data-flip-key]", "data-flip-key", [treesVersion, app.favorites, sections, app.expanded], { enter: isFreshRow });
  useLayoutEffect(() => {
    if (freshPages.size) freshPages = new Set();
  }, [treesVersion]);

  const active = app.workspaces.find((w) => w.id === app.activeWorkspace);
  const sharedWithMe = app.workspaces.filter((w) => w.pageShare && !w.pageShare.home);
  const favorites = app.favorites.filter((f) => f.workspace === app.activeWorkspace);
  const firstWorkspace = useRef(app.activeWorkspace);
  const switched = useRef(false);
  if (!firstWorkspace.current) firstWorkspace.current = app.activeWorkspace;
  if (app.activeWorkspace !== firstWorkspace.current) switched.current = true;
  const sectionOpen = (key: string) => sections[key] !== false;

  const sidebarRef = useClosingFocus<HTMLElement>(!app.sidebarOpen);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    resizing.current = true;
    const startX = event.clientX;
    const startW = width;
    const move = (e: PointerEvent) => setWidth(Math.max(MIN, Math.min(MAX, startW + e.clientX - startX)));
    const up = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <nav ref={sidebarRef} inert={!app.sidebarOpen} className="n-sidebar" style={{ width: app.sidebarOpen ? width : 0 }} aria-label="Sidebar" data-testid="sidebar" aria-hidden={!app.sidebarOpen}>
      <div className="n-sidebar-inner" style={{ width }}>
        <div className="n-sidebar-top">
          <button type="button" className="n-ws-button" data-testid="workspace-switcher" onClick={(e) => setPanel({ kind: "workspace", el: e.currentTarget })}>
            {active ? <WorkspaceTile key={`tile:${active.id}`} workspace={active} /> : null}
            <span key={`name:${active?.id ?? ""}`} className="n-ws-name">{active?.name ?? "Notes"}</span>
            <Icon name="chevronDown" size={12} className="n-ws-chevron" />
          </button>
          <span className="n-spacer" />
          <button type="button" className="n-icon-button" title="Close sidebar (⌘\)" aria-label="Close sidebar" onClick={app.toggleSidebar}>
            <Icon name="chevronsLeft" />
          </button>
          <button type="button" className="n-icon-button" title="New page" aria-label="New page" data-testid="sidebar-new-page-icon" onClick={() => void app.newPage({ workspace: app.activeWorkspace })}>
            <Icon name="compose" />
          </button>
        </div>
        <div className="n-sidebar-nav">
          <NavRow icon="search" label="Search" hint="⌘K" onClick={() => app.openSearch()} testId="nav-search" />
          <NavRow icon="home" label="Home" active={app.route.kind === "home"} onClick={() => app.navigate("/home")} testId="nav-home" />
          <NavRow icon="settings" label="Settings" active={app.route.kind === "settings"} onClick={() => app.navigate("/settings")} testId="nav-settings" />
        </div>
        <div className="n-sidebar-scroll" ref={scrollRef}>
          <div key={app.activeWorkspace} ref={workspaceTreeExit} className={`n-ws-tree${switched.current ? " is-entering" : ""}`} data-testid="workspace-tree" data-workspace={app.activeWorkspace}>
            {favorites.length ? (
              <Section title="Favorites" open={sectionOpen("fav")} onToggle={() => setSections((s) => ({ ...s, fav: !sectionOpen("fav") }))} testId="section-favorites">
                {favorites.map((f) => {
                  const tree = app.trees.get(f.workspace);
                  if (!tree || !getPage(tree, f.page) || isArchivedDeep(tree, f.page)) return null;
                  return <TreeRow key={`fav-${f.page}`} workspace={f.workspace} page={f.page} depth={0} scope="fav" />;
                })}
              </Section>
            ) : null}
            {active ? (
              <Section
                title={active.shared ? "Shared" : "Private"}
                open={sectionOpen(active.id)}
                onToggle={() => setSections((s) => ({ ...s, [active.id]: !sectionOpen(active.id) }))}
                onAdd={() => void app.newPage({ workspace: active.id })}
                dropTo={{ workspace: active.id }}
                testId={active.shared ? `section-${active.id}` : "section-private"}
              >
                <RootPages workspace={active} />
              </Section>
            ) : null}
          </div>
          {sharedWithMe.length ? (
            <Section title="Shared with me" open={sectionOpen("shared-with-me")} onToggle={() => setSections((s) => ({ ...s, "shared-with-me": !sectionOpen("shared-with-me") }))} testId="section-shared-with-me">
              {sharedWithMe.map((w) => (
                <SharedRoot key={w.id} workspace={w} />
              ))}
            </Section>
          ) : null}
          <div className="n-sidebar-group" data-flip-key="group:nav">
            <NavRow icon="template" label="Templates" onClick={() => openGallery({ source: "sidebar", workspace: app.activeWorkspace })} testId="nav-templates" />
            <NavRow icon="trash" label="Trash" active={app.route.kind === "trash"} onClick={(el) => setPanel({ kind: "trash", el })} testId="nav-trash" />
            <NavRow icon="import" label="Import" onClick={() => openImportSheet()} testId="nav-import" />
          </div>
        </div>
        <div className="n-sidebar-foot">
          <button type="button" className="n-new-page" data-testid="sidebar-new-page" onClick={() => void app.newPage({ workspace: app.activeWorkspace })}>
            <Icon name="plus" />
            <span>New page</span>
          </button>
        </div>
      </div>
      {app.sidebarOpen ? <div className="n-sidebar-resizer" onPointerDown={startResize} onDoubleClick={() => setWidth(240)} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" /> : null}
      {panel?.kind === "trash" ? <TrashPopover anchor={panel.el} onClose={() => setPanel(null)} /> : null}
      {panel?.kind === "workspace" ? <WorkspaceMenu anchor={panel.el} onClose={() => setPanel(null)} /> : null}
    </nav>
  );
}

function NavRow({ icon, label, hint, active, onClick, testId }: { icon: string; label: string; hint?: string; active?: boolean; onClick: (el: HTMLElement) => void; testId?: string }) {
  return (
    <button type="button" className={`n-row${active ? " is-selected" : ""}`} onClick={(e) => onClick(e.currentTarget)} data-testid={testId}>
      <span className="n-row-icon">
        <Icon name={icon} />
      </span>
      <span className="n-row-title">{label}</span>
      {hint ? <span className="n-row-hint">{hint}</span> : null}
    </button>
  );
}

function Section({
  title,
  label,
  open,
  onToggle,
  onAdd,
  children,
  dropTo,
  testId,
  icon,
}: {
  title: string;
  label?: string;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  children: React.ReactNode;
  dropTo?: { workspace: WorkspaceId };
  testId?: string;
  icon?: React.ReactNode;
}) {
  const app = useApp();
  const [over, setOver] = useState(false);
  return (
    <div className="n-section" data-testid={testId}>
      <div
        className={`n-section-head${over ? " is-drop" : ""}`}
        data-flip-key={`section:${testId ?? title}`}
        onDragOver={(e) => {
          if (!dropTo || !dragging) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          if (!dropTo || !dragging) return;
          e.preventDefault();
          void app.move(dragging, "", undefined, dragging.workspace === dropTo.workspace ? undefined : dropTo.workspace);
          dragging = null;
        }}
      >
        <button type="button" className="n-section-title" onClick={onToggle} aria-expanded={open}>
          {icon}
          <span>{title}</span>
          {label ? <span className="n-section-badge">{label}</span> : null}
        </button>
        <span className="n-spacer" />
        {onAdd ? (
          <button type="button" className="n-icon-button is-small n-hover-only" aria-label={`Add a page to ${title}`} title="Add a page" onClick={onAdd}>
            <Icon name="plus" size={14} />
          </button>
        ) : null}
      </div>
      <TreeChildren open={open}>
        <div className="n-section-body">{children}</div>
      </TreeChildren>
    </div>
  );
}

function RootPages({ workspace }: { workspace: WorkspaceInfo }) {
  const app = useApp();
  const tree = app.trees.get(workspace.id);
  useTreeVersion(tree);
  if (!tree) return <div className="n-tree-empty">{workspace.state === "downloading" ? "Downloading…" : "Loading…"}</div>;
  const pages = childrenOf(tree, "").filter((p) => !p.isTemplate);
  if (!pages.length) return <div className="n-tree-empty">No pages yet</div>;
  return (
    <>
      {pages.map((p) => (
        <TreeRow key={p.id} workspace={workspace.id} page={p.id} depth={0} scope="tree" />
      ))}
    </>
  );
}

function SharedRoot({ workspace }: { workspace: WorkspaceInfo }) {
  const app = useApp();
  const tree = app.trees.get(workspace.id);
  useTreeVersion(tree);
  const root = workspace.pageShare!.root;
  if (tree && getPage(tree, root)) return <TreeRow workspace={workspace.id} page={root} depth={0} scope="tree" />;
  return (
    <div className="n-row n-tree-row is-share-pending" style={{ paddingLeft: 6 }} data-testid="tree-row" data-page-id={root}>
      <span className="n-row-icon n-tree-icon">
        <span className="n-tree-glyph">
          <PageIcon icon={workspace.icon} fallback="page" />
        </span>
      </span>
      <span className="n-row-title">{workspace.name}</span>
      <span className="n-tree-note">{workspace.state === "missing" ? "Folder missing" : workspace.state === "downloading" ? "Downloading…" : "Loading…"}</span>
    </div>
  );
}

type Slot = { workspace: WorkspaceId; parent: PageId | "" };

function TreeRow({ workspace, page, depth, scope, slot }: { workspace: WorkspaceId; page: PageId; depth: number; scope: "tree" | "fav"; slot?: Slot }) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  useTreeVersion(tree);
  const meta = getPage(tree, page);
  const key = `${scope === "fav" ? "fav:" : ""}${slot?.workspace ?? workspace}:${page}`;
  const open = !!app.expanded[key];
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<HTMLElement | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const [lifted, setLifted] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const leave = useLeaveRef<HTMLDivElement>(() => {
    const placed = slot ? app.trees.get(slot.workspace) : tree;
    return !placed || isArchivedDeep(placed, page);
  }, "is-row-leaving", MOTION.base);
  const [setRow] = useState(() => (el: HTMLDivElement | null) => {
    rowRef.current = el;
    return leave(el);
  });
  const resolveIcon = useFileIcon(app.client, workspace);
  if (!meta) return null;
  if (isShareLink(meta) && !slot) {
    const shareTree = app.trees.get(meta.sharedIn);
    if (shareTree && getPage(shareTree, page)) return <TreeRow workspace={meta.sharedIn} page={page} depth={depth} scope={scope} slot={{ workspace, parent: meta.parent }} />;
  }
  const info = app.workspaces.find((w) => w.id === workspace);
  const shareRoot = info?.pageShare?.root === page;
  const pending = isShareLink(meta);
  const shared = shareRoot || pending;
  const children = meta.kind === "database" || pending ? [] : childrenOf(tree, page).filter((p) => !p.isTemplate);
  const selected = app.route.kind === "page" && app.route.page === page;
  const ref = { workspace, page };
  const placed = slot ? { workspace: slot.workspace, page } : ref;
  const otherWorkspaces = app.workspaces.filter((w) => w.id !== workspace && !w.pageShare);
  const entries: MenuEntry[] = [
    { id: "fav", label: app.isFavorite(page) ? "Remove from Favorites" : "Add to Favorites", icon: app.isFavorite(page) ? "starFilled" : "star", onSelect: () => app.toggleFavorite(ref) },
    { kind: "separator" },
    { id: "copy-link", label: "Copy link", icon: "link", onSelect: () => app.copyLink(ref) },
    ...(shared ? [] : [{ id: "duplicate", label: "Duplicate", icon: "duplicate", onSelect: () => void app.duplicate(ref) } as MenuEntry]),
    { id: "rename", label: "Rename", icon: "edit", onSelect: () => setRenaming(rowRef.current) },
    ...(shareRoot && !slot ? [] : [{ id: "move", label: "Move to", icon: "move", onSelect: () => app.moveDialog(placed) } as MenuEntry]),
    ...(otherWorkspaces.length && !shared && !info?.pageShare ? [{ id: "move-ws", label: "Move to workspace", icon: "folder", submenu: () => otherWorkspaces.map((w): MenuEntry => ({ id: `mv-${w.id}`, label: w.name, icon: <WorkspaceTile workspace={w} size={16} />, onSelect: () => void app.move(ref, "", undefined, w.id) })) } as MenuEntry] : []),
    shareRoot && !slot
      ? { id: "leave", label: "Leave shared page", icon: "arrowUpRight", danger: true, onSelect: () => void app.client.call("leaveWorkspace", { workspace }).then(() => toast(`Left “${displayTitle(meta)}”`)) }
      : { id: "delete", label: "Move to Trash", icon: "trash", danger: true, onSelect: () => void app.archive(placed) },
    { kind: "separator" },
    { id: "new-tab", label: "Open in new tab", icon: "arrowUpRight", hint: "⌘-click", onSelect: () => app.openPage(page, { workspace, newTab: true }) },
  ];
  const onDragOver = (event: React.DragEvent) => {
    if (!dragging || dragging.page === page || pending) return;
    let cursor: string = page;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === dragging.page && dragging.workspace === workspace) return;
      seen.add(cursor);
      cursor = getPage(tree, cursor)?.parent ?? "";
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (shareRoot && !slot) return setZone(meta.kind === "database" ? null : "inside");
    setZone(meta.kind === "database" ? (y < rect.height / 2 ? "before" : "after") : y < rect.height * 0.28 ? "before" : y > rect.height * 0.72 ? "after" : "inside");
  };
  const onDrop = (event: React.DragEvent) => {
    const z = zone;
    setZone(null);
    if (!dragging || !z) return;
    event.preventDefault();
    const moving = dragging;
    dragging = null;
    const toWorkspace = moving.workspace === workspace ? undefined : workspace;
    if (z === "inside") {
      void app.move(moving, page, undefined, toWorkspace);
      app.setExpanded(key, true);
      return;
    }
    const home = slot ?? { workspace, parent: meta.parent };
    const homeTree = app.trees.get(home.workspace);
    if (!homeTree) return;
    const siblings = childrenOf(homeTree, home.parent).filter((p) => p.id !== moving.page);
    const index = siblings.findIndex((s) => s.id === page);
    const after = z === "after" ? page : index > 0 ? siblings[index - 1]!.id : null;
    void app.move(moving, home.parent, after, moving.workspace === home.workspace ? undefined : home.workspace);
  };
  return (
    <div className="n-tree-item" role="treeitem" aria-expanded={children.length ? open : undefined} aria-selected={selected}>
      <div
        ref={setRow}
        className={`n-row n-tree-row${pending ? " is-share-pending" : ""}${selected ? " is-selected" : ""}${menu ? " is-menu-open" : ""}${zone ? ` is-drop-${zone}` : ""}${lifted ? " is-dragging" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        data-testid="tree-row"
        data-page-id={page}
        data-flip-key={`${scope}:${page}`}
        draggable
        onDragStart={(e) => {
          if (shareRoot && !slot) return e.preventDefault();
          dragging = placed;
          requestAnimationFrame(() => setLifted(true));
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(placed));
          e.dataTransfer.setData("text/plain", displayTitle(meta));
        }}
        onDragEnd={() => {
          dragging = null;
          setZone(null);
          setLifted(false);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setZone(null)}
        onDrop={onDrop}
        onClick={(e) => app.openPage(page, { workspace, newTab: e.metaKey })}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(e.currentTarget);
        }}
      >
        <span className="n-row-icon n-tree-icon">
          <span className="n-tree-glyph">
            <PageIcon icon={meta.icon} fallback={meta.kind === "database" ? "database" : "page"} resolveFile={resolveIcon} />
          </span>
          {meta.kind !== "database" && !pending ? (
            <button
              type="button"
              className={`n-tree-chevron${open ? " is-open" : ""}`}
              aria-label={open ? "Collapse" : "Expand"}
              data-testid="tree-chevron"
              onClick={(e) => {
                e.stopPropagation();
                app.setExpanded(key, !open);
              }}
            >
              <Icon name="chevronRight" size={14} strokeWidth={1.6} />
            </button>
          ) : null}
        </span>
        <span className="n-row-title">{displayTitle(meta)}</span>
        {shared ? (
          <span className="n-tree-shared" title={pending ? "Shared · not available right now" : "Shared"} aria-label="Shared" data-testid="tree-shared">
            <Icon name="people" size={13} />
          </span>
        ) : null}
        <span className="n-tree-actions">
          <button
            type="button"
            className="n-icon-button is-small"
            aria-label="Delete, duplicate, and more"
            data-testid="tree-more"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(e.currentTarget);
            }}
          >
            <Icon name="more" size={14} />
          </button>
          {meta.kind !== "database" && !pending ? (
            <button
              type="button"
              className="n-icon-button is-small"
              aria-label="Add a page inside"
              data-testid="tree-add"
              onClick={(e) => {
                e.stopPropagation();
                app.setExpanded(key, true);
                void app.newPage({ workspace, parent: page });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          ) : null}
        </span>
      </div>
      {meta.kind !== "database" && !pending ? (
        <TreeChildren open={open}>
          {children.length ? children.map((c) => <TreeRow key={c.id} workspace={workspace} page={c.id} depth={depth + 1} scope={scope} />) : <div className="n-tree-empty" style={{ paddingLeft: 28 + (depth + 1) * 14 }}>No pages inside</div>}
        </TreeChildren>
      ) : null}
      {menu ? <Menu anchor={menu} onClose={() => setMenu(null)} entries={entries} width={250} testId="page-menu" /> : null}
      {renaming ? <RenamePopover anchor={renaming} workspace={workspace} page={page} onClose={() => setRenaming(null)} /> : null}
    </div>
  );
}


function TreeChildren({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted } = usePresence(open, MOTION.base);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(open);
  useLayoutEffect(() => {
    if (prev.current === open) return;
    prev.current = open;
    if (ref.current) animateHeight(ref.current, open);
  }, [open, mounted]);
  if (!mounted) return null;
  return (
    <div role="group" className="n-tree-children" ref={ref} aria-hidden={!open} inert={!open}>
      {children}
    </div>
  );
}
