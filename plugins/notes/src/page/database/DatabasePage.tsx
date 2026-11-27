import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { pagesOf, updatePage, type PageMeta } from "../../shared/model";
import {
  VIEW_TYPES,
  computeView,
  countFilterRules,
  initDatabase,
  isInitialized,
  moveView,
  readSettings,
  updateSettings,
  updateView,
  settingsOf,
  type View,
  type ViewType,
} from "../../shared/database";
import type { NotesClient } from "../client/types";
import { useDatabase, type DatabaseModel } from "./data";
import { createActions, type Actions } from "./actions";
import { Icon, ViewIcon } from "./icons";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, usePopover, startDrag } from "./ui";
import { FilterBar, SortEditor } from "./filters";
import { PropertyMenu } from "./propertyMenu";
import { ViewSettings } from "./settings";
import { Peek } from "./peek";
import { RowIcon, useFileUrl } from "./cells";
import { TableView } from "./views/table";
import { BoardView } from "./views/board";
import { ListView } from "./views/list";
import { GalleryView } from "./views/gallery";
import { CalendarView } from "./views/calendar";
import { TimelineView } from "./views/timeline";
import { ChartView } from "./views/chart";
import { FormView } from "./views/form";
import type { ViewProps } from "./views/types";
import { registerCss } from "./styles";
import "./styles";
import { openGallery } from "../templates/store";
import { useReveal, useSwapRef } from "../ui/motion";

const VIEW_PRUNE = ".db-card, .db-tr, .db-gallery-card, .db-list-row, .db-tl-row";

export type DatabasePageProps = {
  client: NotesClient;
  workspace: WorkspaceId;
  page: PageId;
  view: string | null;
  inline: boolean;
  onView: (view: string) => void;
  onOpenRow: (row: PageId, mode: "peek" | "full") => void;
  peek?: PageId | null;
  onClosePeek?: () => void;
  renderBody?: (row: PageMeta) => ReactNode;
};

const VIEW_COMPONENTS: Record<ViewType, (p: ViewProps) => ReactNode> = {
  table: TableView,
  board: BoardView,
  list: ListView,
  gallery: GalleryView,
  calendar: CalendarView,
  timeline: TimelineView,
  chart: ChartView,
  form: FormView,
};

function ViewTabIcon({ m, view, size = 14 }: { m: DatabaseModel; view: { type: ViewType; icon: string }; size?: number }) {
  const file = view.icon.startsWith("file:") || /^https:\/\//.test(view.icon) ? view.icon : null;
  const url = useFileUrl(m, file);
  if (file) return url ? <img className="db-view-icon-img" src={url} width={size} height={size} alt="" /> : <ViewIcon type={view.type} size={size} />;
  if (view.icon) return <span className="db-view-icon-emoji" style={{ fontSize: size - 1, width: size, height: size, lineHeight: `${size}px` }}>{view.icon}</span>;
  return <ViewIcon type={view.type} size={size} />;
}

export function DatabasePage(props: DatabasePageProps) {
  const m = useDatabase(props.client, props.workspace, props.page);
  useEffect(() => {
    if (!m || !m.synced || isInitialized(m.doc)) return;
    const initial = m.meta?.props.initialView;
    const type = VIEW_TYPES.some((t) => t.type === initial) ? (initial as ViewType) : VIEW_TYPES.some((t) => t.type === props.view) ? (props.view as ViewType) : "table";
    initDatabase(m.doc, { view: type });
  }, [m?.synced, m?.doc]);
  if (!m) return <div className={`db-root db-page ${props.inline ? "is-inline" : ""} is-loading`} data-testid="db-loading" />;
  if (!m.views.length) return <div className={`db-root db-page ${props.inline ? "is-inline" : ""} is-loading`} data-testid="db-loading" />;
  return <Database {...props} m={m} />;
}

function Database(props: DatabasePageProps & { m: DatabaseModel }) {
  const { m, inline } = props;
  const actions = useMemo(() => createActions(m), [m]);
  const view = m.views.find((v) => v.id === props.view) ?? m.views[0]!;
  const editable = !m.locked;
  const [search, setSearch] = useState("");
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  const moreTabs = usePopover();
  const viewIds = m.views.map((v) => `${v.id}:${v.name}:${v.type}`).join("|");
  useLayoutEffect(() => {
    const box = tabsRef.current;
    if (!box) return;
    const fit = () => {
      const tabs = [...box.querySelectorAll<HTMLElement>("[data-view]")];
      const avail = box.clientWidth - 96;
      let used = 0;
      const hidden: string[] = [];
      for (const el of tabs) {
        used += el.offsetWidth + 2;
        if (used > avail) hidden.push(el.dataset.view!);
      }
      if (hidden.includes(view.id)) {
        const visible = tabs.map((el) => el.dataset.view!).filter((id) => !hidden.includes(id));
        const drop = visible.at(-1);
        hidden.splice(hidden.indexOf(view.id), 1);
        if (drop) hidden.unshift(drop);
      }
      setHiddenTabs((old) => (old.join() === hidden.join() ? old : hidden));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [viewIds, view.id]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [addFilterFor, setAddFilterFor] = useState<string | null>(null);
  const [localPeek, setLocalPeek] = useState<PageId | null>(null);
  const peekId = props.peek !== undefined ? props.peek : localPeek;
  const settingsMenu = usePopover<"main" | "layout">();
  const sortMenu = usePopover();
  const addView = usePopover();
  const tabMenu = usePopover<View>();
  const newMenu = usePopover();
  const rowMenu = usePopover<PageMeta>();
  const propMenu = usePopover<string>();
  const filterPicker = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabDrag, setTabDrag] = useState<{ id: string; over: string | null; before: boolean } | null>(null);

  const [created, setCreated] = useState<{ view: string; ids: ReadonlySet<string> }>({ view: "", ids: new Set() });
  const keep = created.view === view.id ? created.ids : undefined;
  const result = useMemo(() => computeView(m.ctx, view, search, keep), [m.ctx, view, search, keep]);
  const order = useMemo(() => (result.groups ? result.groups.filter((g) => !g.hidden && !g.collapsed).flatMap((g) => g.rows.map((r) => r.id)) : result.rows.map((r) => r.id)), [result]);

  const openRow = useCallback(
    (id: PageId) => {
      const mode = readSettings(m.doc).openAs;
      if (mode === "full") {
        props.onOpenRow(id, "full");
        return;
      }
      setLocalPeek(id);
      props.onOpenRow(id, "peek");
    },
    [m.doc, props.onOpenRow],
  );
  const closePeek = useCallback(() => {
    setLocalPeek(null);
    props.onClosePeek?.();
  }, [props.onClosePeek]);

  const newRow: ViewProps["newRow"] = async (input = {}) => {
    const viewId = view.id;
    const id = await actions.addRow({ view, ...(input.after !== undefined ? { after: input.after } : {}), ...(input.props ? { props: input.props } : {}), ...(input.group ? { group: input.group } : {}), ...(input.title !== undefined ? { title: input.title } : {}) });
    setCreated((c) => ({ view: viewId, ids: new Set(c.view === viewId ? [...c.ids, id] : [id]) }));
    if (input.open) openRow(id);
    return id;
  };

  const viewProps: ViewProps = {
    m,
    actions,
    view,
    result,
    inline,
    editable,
    openRow,
    newRow,
    openPropertyMenu: (prop, anchor) => propMenu.open(anchor, prop),
    openRowMenu: (row, anchor) => rowMenu.open(anchor, row),
  };
  const ViewComponent = VIEW_COMPONENTS[view.type];
  const title = m.meta?.title ?? "";
  const peekRow = peekId ? m.store.pages.get(peekId) : undefined;
  const hasRules = countFilterRules(view.filter) > 0 || view.sorts.length > 0;
  const barShown = editable ? view.filterBar : filterOpen;
  const showBar = barShown || (filterOpen && !hasRules);
  const setBar = (on: boolean) => {
    setFilterOpen(on);
    if (editable && view.filterBar !== on) actions.updateView(view.id, { filterBar: on });
  };
  const description = m.settings.description;
  const viewSwap = useSwapRef<HTMLDivElement>({ prune: VIEW_PRUNE });
  const filterReveal = useReveal<HTMLDivElement>(showBar);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const tab = tabsRef.current?.querySelector<HTMLElement>(`[data-view="${CSS.escape(view.id)}"]`);
    if (!pill) return;
    if (!tab || tab.classList.contains("is-overflow")) {
      pill.style.opacity = "0";
      return;
    }
    const place = () => {
      pill.style.width = `${tab.offsetWidth}px`;
      pill.style.height = `${tab.offsetHeight}px`;
      pill.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
      pill.style.opacity = "1";
    };
    if (!pill.dataset.placed) {
      pill.style.transition = "none";
      place();
      pill.getBoundingClientRect();
      pill.style.transition = "";
      pill.dataset.placed = "1";
    } else place();
    const observer = new ResizeObserver(place);
    observer.observe(tab);
    return () => observer.disconnect();
  }, [view.id, viewIds, hiddenTabs]);

  return (
    <div ref={root} className={`db-root db-page ${inline ? "is-inline" : "is-full"}`} data-testid="db-page" data-database={m.page}>
      {inline ? (
        <InlineTitle m={m} />
      ) : (
        <div className="db-head">
          {m.meta?.icon && (
            <div className="db-head-icon">
              <RowIcon m={m} row={m.meta} size={64} />
            </div>
          )}
          <EditableText className="db-head-title" value={title} placeholder="Untitled" testId="db-title" onCommit={(t) => updatePage(m.tree, m.page, { title: t }, m.me.deviceId)} />
          {(description || !m.locked) && <EditableText className="db-head-desc" value={description} placeholder="Add a description…" testId="db-description" multiline onCommit={(t) => updateSettings(m.doc, { description: t })} />}
        </div>
      )}
      <div className="db-bar-row">
        <div className="db-tabs has-pill" data-testid="db-tabs" role="tablist" ref={tabsRef}>
          <span className="db-tab-pill" aria-hidden="true" ref={pillRef} />
          {m.views.map((v) => (
            <div
              key={v.id}
              role="tab"
              aria-selected={v.id === view.id}
              data-testid="db-tab"
              data-view={v.id}
              className={`db-tab ${v.id === view.id ? "is-active" : ""} ${hiddenTabs.includes(v.id) ? "is-overflow" : ""} ${tabDrag?.over === v.id ? (tabDrag.before ? "is-over-before" : "is-over-after") : ""}`}
              onPointerDown={(e) => {
                if (e.button !== 0 || !editable || renaming) return;
                const id = v.id;
                startDrag(e, {
                  onMove: (ev) => {
                    const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-view]");
                    if (!el || !root.current?.contains(el)) return setTabDrag({ id, over: null, before: false });
                    const r = el.getBoundingClientRect();
                    setTabDrag({ id, over: el.dataset.view ?? null, before: ev.clientX < r.left + r.width / 2 });
                  },
                  onEnd: (_ev, moved) => {
                    setTabDrag((d) => {
                      if (moved && d?.over && d.over !== id) {
                        const others = m.views.filter((x) => x.id !== id);
                        const i = others.findIndex((x) => x.id === d.over);
                        moveView(m.doc, id, d.before ? others[i - 1]?.id ?? null : d.over);
                      }
                      return null;
                    });
                  },
                });
              }}
              onClick={(e) => {
                if (v.id === view.id && editable) tabMenu.open(e.currentTarget, v);
                else props.onView(v.id);
              }}
              onDoubleClick={() => editable && setRenaming(v.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (editable) tabMenu.open(e.currentTarget, v);
              }}
            >
              <ViewTabIcon m={m} view={v} size={14} />
              {renaming === v.id ? (
                <input
                  className="db-tab-input"
                  autoFocus
                  defaultValue={v.name}
                  data-testid="db-tab-rename"
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    if (e.target.value.trim()) actions.updateView(v.id, { name: e.target.value.trim() });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span>{v.name}</span>
              )}
            </div>
          ))}
          {hiddenTabs.length > 0 && (
            <button type="button" className="db-tab db-tab-more" data-testid="db-tabs-more" onClick={(e) => moreTabs.open(e.currentTarget)}>
              {hiddenTabs.length} more
              <Icon name="chevronDown" size={12} />
            </button>
          )}
          {editable && (
            <button type="button" className="db-icon-btn db-tab-add" aria-label="Add view" data-testid="db-add-view" onClick={(e) => addView.open(e.currentTarget)}>
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        <div className="db-tools">
          <button type="button" ref={filterPicker} className={`db-icon-btn ${countFilterRules(view.filter) ? "is-active" : ""}`} aria-label="Filter" title="Filter" data-testid="db-filter-btn" aria-pressed={showBar} onClick={() => setBar(!showBar)}>
            <Icon name="filter" size={16} />
          </button>
          <button type="button" className={`db-icon-btn ${view.sorts.length ? "is-active" : ""}`} aria-label="Sort" title="Sort" data-testid="db-sort-btn" onClick={(e) => sortMenu.open(e.currentTarget)}>
            <Icon name="sort" size={16} />
          </button>
          <div className={`db-search ${searchOpen || search ? "is-open" : ""}`}>
            <button type="button" className="db-icon-btn" aria-label="Search" title="Search" data-testid="db-search-btn" onClick={() => setSearchOpen(true)}>
              <Icon name="search" size={16} />
            </button>
            {(searchOpen || search) && (
              <input
                className="db-search-input"
                autoFocus
                placeholder="Type to search…"
                value={search}
                data-testid="db-search"
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => !search && setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    setSearchOpen(false);
                  }
                }}
              />
            )}
          </div>
          <button type="button" className="db-icon-btn" aria-label="View settings" title="View settings" data-testid="db-settings-btn" onClick={(e) => settingsMenu.open(e.currentTarget, "main")}>
            <Icon name="more" size={16} />
          </button>
          {m.locked && <Icon name="lock" size={14} className="db-lock-icon" />}
          <div className="db-new">
            <button type="button" className="db-new-main" data-testid="db-new" onClick={() => void newRow({ open: true })}>
              New
            </button>
            <button type="button" className="db-new-more" aria-label="Templates" data-testid="db-new-more" onClick={(e) => newMenu.open(e.currentTarget)}>
              <Icon name="chevronDown" size={12} />
            </button>
          </div>
        </div>
      </div>
      {filterReveal.shown && (
        <div ref={filterReveal.ref} className="db-filter-reveal">
          <FilterBar m={m} view={view} editable={editable} openSort={(el) => sortMenu.open(el)} addFilterFor={addFilterFor} clearAddFor={() => setAddFilterFor(null)} />
        </div>
      )}
      {moreTabs.state && (
        <Popover anchor={moreTabs.state.anchor} onClose={moreTabs.close} width={220} testId="db-tabs-more-menu">
          <Menu>
            {m.views
              .filter((v) => hiddenTabs.includes(v.id))
              .map((v) => (
                <MenuItem key={v.id} icon={<ViewTabIcon m={m} view={v} size={16} />} label={v.name} onSelect={() => {
                  moreTabs.close();
                  props.onView(v.id);
                }} />
              ))}
          </Menu>
        </Popover>
      )}
      <div key={view.id} ref={viewSwap} className={`db-view is-${view.type}`} data-testid="db-view" data-view-type={view.type}>
        <ViewComponent {...viewProps} />
      </div>
      {settingsMenu.state && (
        <ViewSettings m={m} actions={actions} view={view} anchor={settingsMenu.state.anchor} initial={settingsMenu.state.value} onClose={settingsMenu.close} onOpenFilter={() => setBar(true)} onOpenSort={() => requestAnimationFrame(() => sortMenu.open(root.current?.querySelector<HTMLElement>('[data-testid="db-sort-btn"]') ?? null))} />
      )}
      {sortMenu.state && <SortEditor m={m} view={view} anchor={sortMenu.state.anchor} onClose={sortMenu.close} />}
      {addView.state && (
        <Popover anchor={addView.state.anchor} onClose={addView.close} width={220} testId="db-add-view-menu">
          <Menu>
            <MenuLabel>Add a view</MenuLabel>
            {VIEW_TYPES.map((t) => (
              <MenuItem key={t.type} icon={<ViewIcon type={t.type} />} label={t.label} testId={`db-add-view-${t.type}`} onSelect={() => {
                addView.close();
                const id = actions.addView(t.type);
                props.onView(id);
              }} />
            ))}
          </Menu>
        </Popover>
      )}
      {tabMenu.state && (
        <Popover anchor={tabMenu.state.anchor} onClose={tabMenu.close} width={220} testId="db-tab-menu">
          <Menu>
            <MenuItem icon="edit" label="Rename" testId="db-tab-menu-rename" onSelect={() => {
              setRenaming(tabMenu.state!.value.id);
              tabMenu.close();
            }} />
            <MenuItem icon="layout" label="Edit view" onSelect={(el) => {
              tabMenu.close();
              settingsMenu.open(el, "main");
            }} />
            <MenuItem icon="copy" label="Duplicate view" testId="db-tab-menu-duplicate" onSelect={() => {
              const id = actions.duplicateView(tabMenu.state!.value.id);
              tabMenu.close();
              if (id) props.onView(id);
            }} />
            <MenuItem icon="trash" label="Delete view" danger disabled={m.views.length <= 1} testId="db-tab-menu-delete" onSelect={() => {
              const id = tabMenu.state!.value.id;
              tabMenu.close();
              const next = m.views.find((v) => v.id !== id);
              actions.deleteView(id);
              if (next) props.onView(next.id);
            }} />
          </Menu>
        </Popover>
      )}
      {newMenu.state && <TemplatesMenu m={m} actions={actions} anchor={newMenu.state.anchor} onClose={newMenu.close} openRow={openRow} view={view} />}
      {rowMenu.state && (
        <Popover anchor={rowMenu.state.anchor} onClose={rowMenu.close} width={220} testId="db-row-menu">
          <Menu>
            <MenuItem icon="sidePeek" label="Open in side peek" onSelect={() => {
              rowMenu.close();
              setLocalPeek(rowMenu.state!.value.id);
              props.onOpenRow(rowMenu.state!.value.id, "peek");
            }} />
            <MenuItem icon="fullPage" label="Open as full page" onSelect={() => {
              rowMenu.close();
              props.onOpenRow(rowMenu.state!.value.id, "full");
            }} />
            <MenuSeparator />
            <MenuItem icon="copy" label="Duplicate" testId="db-row-duplicate" onSelect={() => {
              void actions.duplicateRows([rowMenu.state!.value.id]);
              rowMenu.close();
            }} />
            <MenuItem icon="link" label="Copy link" onSelect={() => {
              const r = rowMenu.state!.value;
              navigator.clipboard?.writeText(`ardia://notes/${(r.title || "Untitled").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Untitled"}-${r.id}`).catch(() => {});
              rowMenu.close();
            }} />
            <MenuItem icon="trash" label="Delete" danger testId="db-row-delete" onSelect={() => {
              actions.deleteRows([rowMenu.state!.value.id]);
              rowMenu.close();
            }} />
          </Menu>
        </Popover>
      )}
      {propMenu.state && m.schema.find((p) => p.id === propMenu.state!.value) && (
        <PropertyMenu m={m} actions={actions} prop={m.schema.find((p) => p.id === propMenu.state!.value)!} view={view} anchor={propMenu.state.anchor} onClose={propMenu.close} onFilter={(prop) => {
          setBar(true);
          setAddFilterFor(prop);
        }} />
      )}
      {peekRow && !peekRow.deleted && (
        <Peek
          m={m}
          row={peekRow}
          order={peekRow.isTemplate ? [peekRow.id] : order}
          mode={m.settings.openAs === "center" ? "center" : "side"}
          onClose={closePeek}
          onOpen={(id) => {
            setLocalPeek(id);
            props.onOpenRow(id, "peek");
          }}
          onFull={(id) => {
            closePeek();
            props.onOpenRow(id, "full");
          }}
          {...(props.renderBody ? { renderBody: props.renderBody } : {})}
        />
      )}
    </div>
  );
}

function TemplatesMenu({ m, actions, anchor, onClose, openRow, view }: { m: DatabaseModel; actions: Actions; anchor: HTMLElement | null | { x: number; y: number }; onClose: () => void; openRow: (id: PageId) => void; view: View }) {
  const more = usePopover<PageMeta>();
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" width={260} testId="db-templates-menu">
      <Menu>
        <MenuLabel>Templates for {m.sourceMeta?.title || "Untitled"}</MenuLabel>
        {m.templates.map((t) => (
          <MenuItem
            key={t.id}
            testId="db-template"
            icon={t.icon ? <span className="db-row-icon">{t.icon.startsWith("file:") ? "" : t.icon}</span> : "page"}
            label={
              <>
                {t.title || "Untitled"}
                {m.settings.defaultTemplate === t.id && <span className="db-default-badge">Default</span>}
              </>
            }
            right={
              <button type="button" className="db-icon-btn" aria-label="Template options" data-testid="db-template-more" onClick={(e) => {
                e.stopPropagation();
                more.open(e.currentTarget, t);
              }}>
                <Icon name="more" size={14} />
              </button>
            }
            onSelect={async () => {
              onClose();
              const id = await actions.addRow({ view, template: t.id });
              openRow(id);
            }}
          />
        ))}
        <MenuItem icon="page" label="Empty page" testId="db-template-empty" onSelect={async () => {
          onClose();
          const id = await actions.addRow({ view, template: null });
          openRow(id);
        }} />
        <MenuSeparator />
        <MenuItem icon="template" label="Browse templates" testId="db-browse-templates" onSelect={() => {
          onClose();
          openGallery({
            source: "database",
            workspace: m.workspace,
            rows: {
              workspace: m.workspace,
              database: m.source,
              title: m.sourceMeta?.title || "Untitled",
              templates: m.templates.map((t) => ({ id: t.id, title: t.title, icon: t.icon })),
              useRowTemplate: async (template) => openRow(await actions.addRow({ view, template })),
              openRow,
            },
          });
        }} />
        <MenuItem icon="plus" label="New template" testId="db-new-template" onSelect={() => {
          onClose();
          const id = actions.addTemplate();
          openRow(id);
        }} />
      </Menu>
      {more.state && (
        <Popover anchor={more.state.anchor} onClose={more.close} placement="right-start" width={200}>
          <Menu>
            <MenuItem icon="check" label={m.settings.defaultTemplate === more.state.value.id ? "Remove default" : "Set as default"} testId="db-template-default" onSelect={() => {
              updateSettings(m.doc, { defaultTemplate: m.settings.defaultTemplate === more.state!.value.id ? "" : more.state!.value.id });
              more.close();
            }} />
            <MenuItem icon="edit" label="Edit" onSelect={() => {
              const id = more.state!.value.id;
              more.close();
              onClose();
              openRow(id);
            }} />
            <MenuItem icon="copy" label="Duplicate" onSelect={async () => {
              const { page } = await m.client.call("duplicatePage", { workspace: m.workspace, page: more.state!.value.id });
              pagesOf(m.tree).get(page)?.set("isTemplate", true);
              more.close();
            }} />
            <MenuItem icon="trash" label="Delete" danger onSelect={() => {
              if (m.settings.defaultTemplate === more.state!.value.id) updateSettings(m.doc, { defaultTemplate: "" });
              actions.deleteRows([more.state!.value.id]);
              more.close();
            }} />
          </Menu>
        </Popover>
      )}
    </Popover>
  );
}

function InlineTitle({ m }: { m: DatabaseModel }) {
  const linked = m.source !== m.page;
  const title = m.meta?.title || (linked ? m.sourceMeta?.title ?? "" : "");
  return (
    <div className="db-inline-head">
      {linked && <Icon name="relation" size={14} className="db-linked-icon" />}
      <EditableText className="db-inline-title" value={title} placeholder="Untitled" testId="db-title" onCommit={(t) => updatePage(m.tree, m.page, { title: t }, m.me.deviceId)} />
    </div>
  );
}

function EditableText({ value, onCommit, placeholder, className, testId, multiline }: { value: string; onCommit: (v: string) => void; placeholder: string; className: string; testId?: string; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`db-editable ${className}`}
      value={draft}
      placeholder={placeholder}
      data-testid={testId}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(multiline ? e.target.value : e.target.value.replace(/\n/g, ""))}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

export { settingsOf, updateView };

registerCss(
  "page",
  `
.db-page { position: relative; }
.db-page.is-full { --db-gutter: max(24px, min(96px, calc((100vw - var(--n-page-width, 708px)) / 2 - 120px))); padding: 0 var(--db-gutter) 120px; min-width: 0; }
.db-page.is-loading { min-height: 120px; }
.db-head { padding-top: 48px; }
.db-head-icon { margin-bottom: 10px; line-height: 1; }
.db-editable { display: block; width: 100%; border: none; outline: none; resize: none; background: transparent; color: var(--n-text); font: inherit; padding: 0; overflow: hidden; }
.db-editable::placeholder { color: var(--n-text-3); }
.db-head-title { font-size: 40px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 6px; }
.db-head-desc { font-size: var(--n-t-body, 13px); color: var(--n-text-2); margin-bottom: 18px; }
.db-head-desc::placeholder { color: transparent; }
.db-head:hover .db-head-desc::placeholder, .db-head-desc:focus::placeholder { color: var(--n-text-3); }
.db-inline-head { display: flex; align-items: center; gap: 6px; padding: 4px 0 2px; }
.db-inline-title { font-size: 20px; font-weight: var(--n-w-semibold, 600); line-height: 1.3; }
.db-linked-icon { color: var(--n-text-3); }
.db-bar-row { display: flex; align-items: center; gap: 8px; min-height: 40px; }
.db-tabs { position: relative; display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow: hidden; height: 40px; }
.db-tab.is-overflow { position: absolute; visibility: hidden; pointer-events: none; }
.db-tab-more { color: var(--n-text-3); border: none; background: none; }
.db-view-icon-img { display: block; flex: none; object-fit: contain; opacity: .8; }
.db-view-icon-emoji { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.db-tab { position: relative; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: var(--n-r-control, 4px); color: var(--n-text-2); font-size: var(--n-t-small, 12px); font-weight: var(--n-w-medium, 500); white-space: nowrap; cursor: default; user-select: none; flex: none; }
.db-tab:hover { background: var(--n-tool-hover); color: var(--n-text); }
.db-tab.is-active { color: var(--n-text); background: var(--n-tool-pressed); }
.db-tabs.has-pill .db-tab.is-active { background: transparent; }
.db-tab-pill { position: absolute; left: 0; top: 0; border-radius: var(--n-r-control, 4px); background: var(--n-tool-pressed); pointer-events: none; opacity: 0; transition: transform var(--n-base, 160ms) var(--n-ease-out), width var(--n-base, 160ms) var(--n-ease-out), opacity var(--n-fast, 120ms) var(--n-ease-out); }
@media (prefers-reduced-motion: reduce) { .db-tab-pill { transition: opacity var(--n-fast, 120ms) var(--n-ease-out); } }
.db-tab.is-active::after { content: none; }
.db-tab.is-over-before { box-shadow: -2px 0 0 var(--n-form-accent); }
.db-tab.is-over-after { box-shadow: 2px 0 0 var(--n-form-accent); }
.db-tab-input { width: 120px; height: 22px; border: none; outline: none; box-shadow: inset 0 0 0 1px var(--n-form-accent), 0 0 0 3px color-mix(in srgb, var(--n-form-accent) 30%, transparent); border-radius: var(--n-r-control, 4px); background: var(--n-field); color: var(--n-text); font: inherit; font-size: var(--n-t-small, 12px); padding: 0 6px; }
.db-tab-add { color: var(--n-text-3); }
.db-tools { display: flex; align-items: center; gap: 2px; flex: none; }
.db-tools .db-icon-btn { width: 26px; height: 26px; color: var(--n-icon); }
.db-tools .db-icon-btn:hover { color: var(--n-text); }
.db-tools .db-icon-btn.is-active { color: var(--n-text); background: var(--n-tool-pressed); }
.db-lock-icon { color: var(--n-text-3); margin: 0 4px; }
.db-search { display: flex; align-items: center; }
.db-search-input { width: 0; border: none; outline: none; background: transparent; color: var(--n-text); font: inherit; font-size: var(--n-t-body, 13px); height: 26px; transition: width var(--n-fast, 100ms) var(--n-ease); }
.db-search.is-open .db-search-input { width: 160px; }
.db-new { display: inline-flex; margin-left: 6px; height: 26px; border-radius: var(--n-r-tile, 8px); overflow: hidden; background: var(--n-go); color: var(--n-on-go); }
.db-new button { border: none; background: transparent; color: inherit; font-size: var(--n-t-body, 13px); font-weight: var(--n-w-medium, 500); cursor: default; }
.db-new button:hover { background: var(--n-go-hover); }
.db-new button:active { background: var(--n-go-pressed); }
.db-new-main { padding: 0 12px; }
.db-new-more { width: 24px; display: inline-flex; align-items: center; justify-content: center; box-shadow: inset 0.5px 0 0 color-mix(in srgb, var(--n-on-go) 22%, transparent); }
.db-default-badge { font-size: var(--n-t-caption, 11px); color: var(--n-text-2); background: var(--n-badge); border-radius: var(--n-r-control, 4px); padding: 0 5px; margin-left: 6px; }
.db-view { position: relative; padding-top: 2px; }
.db-page.is-inline .db-view.is-table { margin-left: 0; }
`,
);
