import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ancestorsOf, displayTitle, getPage, isArchivedDeep, pagePath, updatePage } from "../../shared/model";
import type { PageId, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";
import { useApp } from "../app/context";
import { useFileIcon } from "../app/files";
import { relativeTime, useNow, usePageMeta, useTreeVersion } from "../app/hooks";
import { Avatar } from "../comments/Comments";
import type { EditorHandle } from "../editor/NoteEditor";
import { Icon, PageIcon } from "../ui/icons";
import { Menu, type MenuEntry } from "../ui/Menu";
import { Popover } from "../ui/Popover";
import { crossfadeRef, exitRef, MOTION } from "../ui/motion";

const crumbsFade = crossfadeRef<HTMLElement>('[data-testid="breadcrumbs"]', ".n-crumbs > *");
const editedFade = crossfadeRef<HTMLSpanElement>('[data-testid="edited"]', ".n-edited-text");
import { SaveIndicator } from "./SaveIndicator";
import { toast } from "../ui/toast";
import { RenamePopover } from "../sidebar/RenamePopover";
import { WorkspaceTile } from "../sidebar/WorkspaceMenu";
import { exportHtml, exportMarkdown, exportText, importMarkdown } from "./exporting";
import { saveAsTemplate } from "../templates/actions";
import { openGallery } from "../templates/store";

type Person = { key: string; name: string; color: string };

function usePeopleHere(page: PageId, handle: EditorHandle | null, awareness: import("y-protocols/awareness").Awareness | null): Person[] {
  const app = useApp();
  const version = useSyncExternalStore(
    (listener) => {
      if (!awareness) return () => {};
      let live = true;
      const deferred = () => queueMicrotask(() => live && listener());
      awareness.on("change", deferred);
      return () => {
        live = false;
        awareness.off("change", deferred);
      };
    },
    () => (awareness ? [...awareness.getStates().entries()].map(([id, s]) => `${id}:${JSON.stringify((s as { user?: unknown }).user ?? null)}`).join("|") : ""),
  );
  void version;
  void handle;
  const out = new Map<string, Person>();
  for (const entry of app.presence) {
    if (entry.page !== page || entry.deviceId === app.me.deviceId) continue;
    out.set(`${entry.name}|${entry.color}`, { key: entry.deviceId, name: entry.name || "Someone", color: entry.color });
  }
  if (awareness) {
    for (const [id, state] of awareness.getStates()) {
      if (id === awareness.clientID) continue;
      const user = (state as { user?: { name?: string; color?: string } }).user;
      if (!user?.name) continue;
      const key = `${user.name}|${user.color}`;
      if (!out.has(key)) out.set(key, { key: String(id), name: user.name, color: user.color ?? "" });
    }
  }
  return [...out.values()];
}

type WordBlock = { content?: unknown; children?: WordBlock[] };

function countWords(blocks: WordBlock[]): number {
  let words = 0;
  const visitInline = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items as { text?: unknown; content?: unknown }[]) {
      if (typeof item?.text === "string") words += item.text.split(/\s+/).filter(Boolean).length;
      if (Array.isArray(item?.content)) visitInline(item.content);
    }
  };
  const visit = (list: WordBlock[]) => {
    for (const block of list) {
      const content = block.content as { rows?: { cells?: unknown[] }[] } | unknown[] | undefined;
      if (Array.isArray(content)) visitInline(content);
      else if (content && Array.isArray((content as { rows?: unknown[] }).rows)) for (const row of (content as { rows: { cells?: unknown[] }[] }).rows) for (const cell of row.cells ?? []) visitInline(Array.isArray(cell) ? cell : (cell as { content?: unknown })?.content);
      if (block.children?.length) visit(block.children);
    }
  };
  visit(blocks);
  return words;
}

export function Topbar({ workspace, page, handle, commentsOpen, onToggleComments, onHistory }: { workspace: WorkspaceId; page: PageId; handle: EditorHandle | null; commentsOpen: boolean; onToggleComments: () => void; onHistory: () => void }) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  useTreeVersion(tree);
  const meta = usePageMeta(tree, page);
  const now = useNow();
  const resolve = useFileIcon(app.client, workspace);
  const pageOf = (id: string) => {
    for (const other of app.trees.values()) {
      const found = getPage(other, id);
      if (found) return found;
    }
    return null;
  };
  const [menu, setMenu] = useState<{ kind: "more" | "share" | "crumbs"; el: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<HTMLElement | null>(null);
  const awareness = useRef<import("y-protocols/awareness").Awareness | null>(null);
  const [aw, setAw] = useState<import("y-protocols/awareness").Awareness | null>(null);
  useEffect(() => {
    const opened = app.client.open(workspace, `p:${page}`);
    awareness.current = opened.awareness;
    setAw(opened.awareness);
    return () => opened.release();
  }, [workspace, page]);
  const people = usePeopleHere(page, handle, aw);
  if (!meta) return null;
  const ws = app.workspaces.find((w) => w.id === workspace);
  const pageShare = ws?.pageShare ?? null;
  const shareHome = pageShare?.home ? app.trees.get(pageShare.home) : null;
  const lead = pageShare && shareHome ? ancestorsOf(shareHome, pageShare.root).map((p) => ({ ...p, ws: pageShare.home! })) : [];
  const trail = [...lead, ...ancestorsOf(tree, page).map((p) => ({ ...p, ws: workspace }))];
  const collapsed = trail.length > 2 ? trail.slice(1, -1) : [];
  const shown = trail.length > 2 ? [trail[0]!, null, trail.at(-1)!] : trail;
  const shareRoot = pageShare?.root === page;
  const placed = shareRoot && pageShare?.home ? { workspace: pageShare.home, page } : { workspace, page };
  const favorite = app.isFavorite(page);
  const archived = isArchivedDeep(tree, page);
  const set = (patch: Parameters<typeof updatePage>[2]) => updatePage(tree, page, patch, app.me.deviceId);
  const editor = handle?.editor;
  const wordCount = menu?.kind === "more" && editor ? countWords(editor.document as unknown as WordBlock[]) : 0;
  const ref = { workspace, page };
  const moreEntries: MenuEntry[] = [
    {
      kind: "custom",
      render: () => (
        <div className="n-font-picker" role="radiogroup" aria-label="Page font">
          {(["default", "serif", "mono"] as const).map((font) => (
            <button key={font} type="button" role="radio" aria-checked={meta.font === font} data-testid={`font-${font}`} className={`n-font-option font-${font}${meta.font === font ? " is-on" : ""}`} onClick={() => set({ font })}>
              <span className="n-font-sample">Ag</span>
              <span className="n-font-name">{font === "default" ? "Default" : font === "serif" ? "Serif" : "Mono"}</span>
            </button>
          ))}
        </div>
      ),
    },
    { kind: "separator" },
    { id: "small-text", label: "Small text", icon: "text", keepOpen: true, trailing: <Toggle on={meta.smallText} />, onSelect: () => set({ smallText: !meta.smallText }) },
    { id: "full-width", label: "Full width", icon: "fullWidth", keepOpen: true, trailing: <Toggle on={meta.fullWidth} />, onSelect: () => set({ fullWidth: !meta.fullWidth }) },
    { id: "lock", label: "Lock page", icon: meta.locked ? "lock" : "unlock", keepOpen: true, trailing: <Toggle on={meta.locked} />, onSelect: () => set({ locked: !meta.locked }) },
    { kind: "separator" },
    { id: "fav", label: favorite ? "Remove from Favorites" : "Add to Favorites", icon: favorite ? "starFilled" : "star", onSelect: () => app.toggleFavorite(ref) },
    { id: "copy-link", label: "Copy link", icon: "link", onSelect: () => app.copyLink(ref) },
    {
      id: "duplicate",
      label: "Duplicate",
      icon: "duplicate",
      disabled: shareRoot,
      onSelect: () =>
        void app.duplicate(ref).then((copy) => {
          if (copy) app.openPage(copy.page, { workspace });
        }),
    },
    { id: "move", label: "Move to", icon: "move", disabled: shareRoot && !pageShare?.home, onSelect: () => app.moveDialog(placed) },
    meta.isTemplate
      ? { id: "template", label: "Stop using as template", icon: "template", onSelect: () => set({ isTemplate: false }) }
      : {
          id: "template",
          label: "Save as template",
          icon: "template",
          disabled: archived,
          onSelect: () =>
            void saveAsTemplate(app, ref, { asRow: getPage(tree, meta.parent)?.kind === "database" }).then(
              () => toast(`Saved “${displayTitle(meta)}” as a template`, { label: "Show", run: () => openGallery({ source: "menu", workspace, category: "yours" }) }),
              (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
            ),
        },
    { id: "delete", label: "Move to Trash", icon: "trash", danger: true, disabled: archived || (shareRoot && !pageShare?.home), onSelect: () => void app.archive(placed) },
    { kind: "separator" },
    { id: "undo", label: "Undo", icon: "undo", hint: "⌘Z", disabled: !editor, onSelect: () => editor?.undo() },
    { id: "history", label: "Version history", icon: "clock", onSelect: onHistory },
    { id: "comments", label: commentsOpen ? "Hide comments" : "Show all comments", icon: "comment", onSelect: onToggleComments },
    { kind: "separator" },
    { id: "import", label: "Import Markdown", icon: "import", disabled: !editor || meta.locked, onSelect: () => editor && void importMarkdown(editor) },
    {
      id: "export",
      label: "Export",
      icon: "export",
      submenu: () => [
        { id: "export-md", label: "Markdown", icon: "page", onSelect: () => editor && void exportText(app.client, `${displayTitle(meta)}.md`, "text/markdown", exportMarkdown(editor, meta, pageOf)) },
        { id: "export-html", label: "HTML", icon: "code", onSelect: () => editor && void exportText(app.client, `${displayTitle(meta)}.html`, "text/html", exportHtml(editor, meta, pageOf)) },
      ],
    },
  ];
  return (
    <header className="n-topbar" data-testid="topbar">
      {!app.sidebarOpen ? (
        <button type="button" className="n-icon-button" aria-label="Open sidebar" title="Open sidebar (⌘\)" onClick={app.toggleSidebar}>
          <Icon name="sidebar" />
        </button>
      ) : null}
      <nav ref={crumbsFade} className="n-crumbs" aria-label="Breadcrumbs" data-testid="breadcrumbs">
        {ws?.shared && !pageShare ? (
          <span className="n-crumb is-static">
            <WorkspaceTile workspace={ws} size={14} />
            <span className="n-crumb-title">{ws.name}</span>
            <span className="n-crumb-sep">/</span>
          </span>
        ) : null}
        {pageShare && !shareHome ? (
          <span className="n-crumb is-static" data-testid="crumb-shared-with-me">
            <Icon name="people" size={14} />
            <span className="n-crumb-title">Shared with me</span>
            <span className="n-crumb-sep">/</span>
          </span>
        ) : null}
        {shown.map((p, i) =>
          p ? (
            <span key={p.id} className="n-crumb-wrap">
              <button type="button" className="n-crumb" onClick={() => app.openPage(p.id, { workspace: p.ws })}>
                <PageIcon icon={p.icon} size={14} resolveFile={resolve} />
                <span className="n-crumb-title">{displayTitle(p)}</span>
              </button>
              <span className="n-crumb-sep">/</span>
            </span>
          ) : (
            <span key={`gap${i}`} className="n-crumb-wrap">
              <button type="button" className="n-crumb" aria-label="Show hidden pages" onClick={(e) => setMenu({ kind: "crumbs", el: e.currentTarget })}>
                …
              </button>
              <span className="n-crumb-sep">/</span>
            </span>
          ),
        )}
        <button type="button" className="n-crumb is-current" data-testid="crumb-current" onClick={(e) => setRenaming(e.currentTarget)}>
          <PageIcon icon={meta.icon} size={14} resolveFile={resolve} />
          <span className="n-crumb-title">{displayTitle(meta)}</span>
          {pageShare ? <Icon name="people" size={12} className="n-crumb-shared" /> : null}
        </button>
        {meta.locked ? (
          <button type="button" className="n-lock-badge" title="Unlock page" data-testid="lock-badge" onClick={() => set({ locked: false })}>
            <Icon name="lock" size={12} />
            Locked
          </button>
        ) : null}
      </nav>
      <span className="n-spacer" />
      <span className="n-save-slot">
        <SaveIndicator client={app.client} />
      </span>
      <span ref={editedFade} className="n-edited" data-testid="edited">
        <span className="n-edited-text">Edited {relativeTime(meta.updatedAt, now)}</span>
      </span>
      <div className="n-presence" data-testid="presence">
        {people.slice(0, 4).map((p) => (
          <span key={p.key} className="n-presence-avatar" data-testid="presence-avatar" title={p.name} ref={exitRef<HTMLSpanElement>("is-avatar-leaving", MOTION.base)}>
            <Avatar name={p.name} color={p.color} size={24} />
          </span>
        ))}
        {people.length > 4 ? <span className="n-presence-more">+{people.length - 4}</span> : null}
      </div>
      <button type="button" className="n-text-button" data-testid="share-button" onClick={(e) => setMenu({ kind: "share", el: e.currentTarget })}>
        Share
      </button>
      <button type="button" className={`n-icon-button${commentsOpen ? " is-on" : ""}`} aria-label="Comments" aria-pressed={commentsOpen} title="View all comments" data-testid="comments-toggle" onClick={onToggleComments}>
        <Icon name="comment" />
      </button>
      <button type="button" className="n-icon-button" aria-label="Version history" title="Version history" data-testid="history-button" onClick={onHistory}>
        <Icon name="clock" />
      </button>
      <button type="button" className={`n-icon-button${favorite ? " is-favorite" : ""}`} aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"} aria-pressed={favorite} data-testid="favorite-button" onClick={() => app.toggleFavorite(ref)}>
        <Icon name={favorite ? "starFilled" : "star"} />
      </button>
      <button type="button" className="n-icon-button" aria-label="Style, export, and more" data-testid="page-more" onClick={(e) => setMenu({ kind: "more", el: e.currentTarget })}>
        <Icon name="more" />
      </button>
      {menu?.kind === "more" ? (
        <Menu
          anchor={menu.el}
          onClose={() => setMenu(null)}
          entries={moreEntries}
          placement="bottom-end"
          width={264}
          testId="page-more-menu"
          footer={
            <div className="n-menu-footer">
              <div>Word count: {wordCount}</div>
              <div>
                Last edited {relativeTime(meta.updatedAt, now)}
                {meta.updatedBy === app.me.deviceId ? " by you" : ""}
              </div>
            </div>
          }
        />
      ) : null}
      {menu?.kind === "crumbs" ? (
        <Menu anchor={menu.el} onClose={() => setMenu(null)} entries={collapsed.map((p) => ({ id: p.id, label: displayTitle(p), icon: <PageIcon icon={p.icon} />, onSelect: () => app.openPage(p.id, { workspace: p.ws }) }))} />
      ) : null}
      {menu?.kind === "share" ? <SharePopover anchor={menu.el} workspace={workspace} page={page} onClose={() => setMenu(null)} /> : null}
      {renaming ? <RenamePopover anchor={renaming} workspace={workspace} page={page} onClose={() => setRenaming(null)} /> : null}
    </header>
  );
}

function Toggle({ on }: { on: boolean }) {
  return <span className={`n-switch${on ? " is-on" : ""}`} aria-hidden="true" />;
}

function SharePopover({ anchor, workspace, page, onClose }: { anchor: HTMLElement; workspace: WorkspaceId; page: PageId; onClose: () => void }) {
  const app = useApp();
  const ws = app.workspaces.find((w) => w.id === workspace);
  const tree = app.trees.get(workspace)!;
  const meta = getPage(tree, page);
  const link = `ardia://notes${meta ? pagePath(meta) : `/${page}`}`;
  let body: React.ReactNode;
  if (ws?.pageShare) body = <PageShareBody workspace={ws} page={page} onClose={onClose} />;
  else if (ws?.shared)
    body = (
      <>
        <div className="n-share-head">
          <WorkspaceTile workspace={ws} size={28} />
          <div>
            <div className="n-share-title">Shared in {ws.name}</div>
            <div className="n-muted">Everyone with the {ws.name} folder can see and edit this page. It syncs through iCloud Drive.</div>
          </div>
        </div>
        <div className="n-row-buttons">
          <button
            type="button"
            className="n-button is-primary"
            data-testid="share-workspace"
            onClick={async () => {
              onClose();
              await app.client.call("shareWorkspace", { workspace });
            }}
          >
            Invite people…
          </button>
        </div>
      </>
    );
  else body = <PrivateShareBody workspace={workspace} page={page} onClose={onClose} />;
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" width={380} label="Share">
      <div className="n-share" data-testid="share-popover">
        {body}
        <div className="n-menu-sep" />
        <div className="n-share-link">
          <span className="n-share-url">{link}</span>
          <button type="button" className="n-button is-small" data-testid="share-copy-link" onClick={() => app.copyLink({ workspace, page })}>
            Copy link
          </button>
        </div>
      </div>
    </Popover>
  );
}

const failed = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

function PrivateShareBody({ workspace, page, onClose }: { workspace: WorkspaceId; page: PageId; onClose: () => void }) {
  const app = useApp();
  const tree = app.trees.get(workspace)!;
  const meta = getPage(tree, page);
  const shared = app.workspaces.filter((w) => w.shared && !w.pageShare && w.id !== workspace);
  const row = !!meta?.parent && getPage(tree, meta.parent)?.kind === "database";
  const canShare = !!meta && !row && !meta.isTemplate && !isArchivedDeep(tree, page);
  const title = displayTitle(meta);
  return (
    <>
      <div className="n-share-head">
        <span className="n-share-lock">
          <Icon name="lock" size={16} />
        </span>
        <div>
          <div className="n-share-title">Only you can see this page</div>
          <div className="n-muted">{row ? "It’s a row of a database. Share the database to work on it with others." : "Share it to work on it with others. It stays where it is in your sidebar."}</div>
        </div>
      </div>
      {canShare ? (
        <button
          type="button"
          className="n-button is-primary n-share-primary"
          data-testid="share-page"
          onClick={async () => {
            onClose();
            try {
              const made = await app.client.call("sharePage", { workspace, page });
              if (made) toast(`Shared “${title}”`);
            } catch (error) {
              failed(error);
            }
          }}
        >
          Share this page
        </button>
      ) : null}
      {canShare ? <div className="n-muted n-share-note">Makes a folder for it, and the pages inside, in iCloud Drive › Ardia Shared.</div> : null}
      <div className="n-menu-sep" />
      <div className="n-menu-heading n-share-heading">Or move it to a shared workspace</div>
      {shared.map((w) => (
        <button
          key={w.id}
          type="button"
          className="n-menu-item"
          data-testid="share-move"
          onClick={async () => {
            onClose();
            const moved = await app.move({ workspace, page }, "", undefined, w.id).catch((error: unknown) => (failed(error), null));
            if (moved) {
              toast(`Moved to ${w.name}`);
              app.openPage(moved.page, { workspace: moved.workspace, replace: true });
            }
          }}
        >
          <span className="n-menu-icon">
            <WorkspaceTile workspace={w} size={18} />
          </span>
          <span className="n-menu-label">Move to {w.name}</span>
        </button>
      ))}
      <button
        type="button"
        className="n-menu-item"
        data-testid="share-create-workspace"
        onClick={async () => {
          onClose();
          const created = await app.client.call("createSharedWorkspace", { name: "Shared notes" });
          if (created) {
            const moved = await app.move({ workspace, page }, "", undefined, created.id).catch((error: unknown) => (failed(error), null));
            if (moved) app.openPage(moved.page, { workspace: moved.workspace, replace: true });
          }
        }}
      >
        <span className="n-menu-icon">
          <Icon name="people" />
        </span>
        <span className="n-menu-label">Create a shared workspace and move it…</span>
      </button>
    </>
  );
}

function PageShareBody({ workspace, page, onClose }: { workspace: WorkspaceInfo; page: PageId; onClose: () => void }) {
  const app = useApp();
  const [confirming, setConfirming] = useState(false);
  const share = workspace.pageShare!;
  const tree = app.trees.get(workspace.id);
  const root = tree ? getPage(tree, share.root) : null;
  const owner = !!share.home;
  const people = [...new Map(app.presence.filter((p) => p.workspace === workspace.id && p.deviceId !== app.me.deviceId).map((p) => [`${p.name}|${p.color}`, p])).values()];
  const through = `${share.location === "icloud" ? "iCloud Drive › Ardia Shared" : "a shared folder"} › ${share.folder}`;
  return (
    <>
      <div className="n-share-head">
        <span className="n-share-lock is-shared">
          <Icon name="people" size={16} />
        </span>
        <div>
          <div className="n-share-title" data-testid="share-title">{owner ? "Shared page" : "Shared with you"}</div>
          <div className="n-muted">
            {page === share.root ? "This page and the pages inside it" : `Part of “${displayTitle(root)}”`}, shared through <span data-testid="share-through">{through}</span>.
          </div>
        </div>
      </div>
      <div className="n-share-people" data-testid="share-people">
        <span className="n-share-person">
          <Avatar name={app.me.name} color={app.me.color} size={20} />
          <span>{app.me.name || "You"} (you)</span>
        </span>
        {people.map((p) => (
          <span key={p.deviceId} className="n-share-person">
            <Avatar name={p.name} color={p.color} size={20} />
            <span>{p.name || "Someone"}</span>
          </span>
        ))}
      </div>
      <div className="n-row-buttons">
        <button
          type="button"
          className="n-button is-primary"
          data-testid="share-invite"
          onClick={async () => {
            onClose();
            await app.client.call("shareWorkspace", { workspace: workspace.id }).catch(failed);
          }}
        >
          Invite people…
        </button>
        {owner ? (
          <button
            type="button"
            className={`n-button${confirming ? " is-danger" : ""}`}
            data-testid="share-stop"
            onClick={async () => {
              if (!confirming) return setConfirming(true);
              onClose();
              try {
                const back = await app.client.call("stopSharingPage", { workspace: workspace.id });
                toast(`“${displayTitle(root)}” is private again`);
                if (app.route.kind === "page") app.openPage(app.route.page, { workspace: back.workspace, replace: true });
              } catch (error) {
                failed(error);
              }
            }}
          >
            {confirming ? "Yes, stop sharing" : "Stop sharing"}
          </button>
        ) : (
          <button
            type="button"
            className="n-button"
            data-testid="share-leave"
            onClick={async () => {
              onClose();
              await app.client.call("leaveWorkspace", { workspace: workspace.id }).then(() => {
                toast(`Left “${displayTitle(root)}”`);
                app.navigate("/home", { replace: true });
              }, failed);
            }}
          >
            Leave
          </button>
        )}
      </div>
      {confirming ? <div className="n-muted n-share-note" data-testid="share-stop-note">It comes back to Private where it is now. People you invited keep the copy they have.</div> : null}
    </>
  );
}
