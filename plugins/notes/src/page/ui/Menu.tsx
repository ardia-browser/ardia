import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Popover, type Anchor } from "./Popover";
import type { Placement } from "@floating-ui/react";

export type MenuEntry =
  | {
      kind?: "item";
      id?: string;
      label: string;
      icon?: IconName | ReactNode;
      hint?: string;
      detail?: string;
      danger?: boolean;
      checked?: boolean;
      disabled?: boolean;
      keepOpen?: boolean;
      aliases?: string[];
      onSelect?: () => void;
      submenu?: () => MenuEntry[];
      trailing?: ReactNode;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string }
  | { kind: "custom"; render: () => ReactNode };

type Item = Extract<MenuEntry, { label: string; kind?: "item" }>;

const isItem = (entry: MenuEntry): entry is Item => entry.kind === undefined || entry.kind === "item";

export function MenuList({
  entries,
  onClose,
  search,
  searchPlaceholder = "Search…",
  autoFocusSearch = true,
  footer,
  testId,
}: {
  entries: MenuEntry[];
  onClose: () => void;
  search?: boolean;
  searchPlaceholder?: string;
  autoFocusSearch?: boolean;
  footer?: ReactNode;
  testId?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; el: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    if (!query.trim()) return entries;
    const q = query.trim().toLowerCase();
    const out = entries.filter((e) => isItem(e) && (e.label.toLowerCase().includes(q) || e.aliases?.some((a) => a.toLowerCase().includes(q))));
    return out;
  }, [entries, query]);
  const selectable = visible.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);

  useEffect(() => {
    setActive(query ? (selectable[0] ?? -1) : -1);
  }, [query]);

  const choose = (index: number, el?: HTMLElement | null) => {
    const entry = visible[index];
    if (!entry || !isItem(entry) || entry.disabled) return;
    if (entry.submenu) {
      const target = el ?? listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (target) setSub({ index, el: target });
      return;
    }
    entry.onSelect?.();
    if (!entry.keepOpen) onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sub) return;
      if (!listRef.current?.isConnected) return;
      const owner = listRef.current.closest("[data-popover-id]");
      const all = [...document.querySelectorAll("[data-popover-id]")];
      if (owner && all.at(-1) !== owner) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!selectable.length) return;
        const pos = selectable.indexOf(active);
        const next = event.key === "ArrowDown" ? selectable[(pos + 1) % selectable.length] : selectable[(pos - 1 + selectable.length) % selectable.length];
        setActive(next ?? -1);
        listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && (active >= 0 || (query && selectable.length))) {
        event.preventDefault();
        event.stopPropagation();
        choose(active >= 0 ? active : selectable[0]!);
      } else if (event.key === "ArrowRight" && active >= 0) {
        const entry = visible[active];
        if (entry && isItem(entry) && entry.submenu) {
          event.preventDefault();
          choose(active);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const subEntry = sub ? visible[sub.index] : null;
  return (
    <div className="n-menu" ref={listRef} data-testid={testId} role="menu">
      {search ? (
        <div className="n-menu-search">
          <input autoFocus={autoFocusSearch} value={query} placeholder={searchPlaceholder} onChange={(e) => setQuery(e.target.value)} />
        </div>
      ) : null}
      <div className="n-menu-scroll">
        {visible.map((entry, index) => {
          if (entry.kind === "separator") return <div key={`s${index}`} className="n-menu-sep" />;
          if (entry.kind === "heading") return <div key={`h${index}`} className="n-menu-heading">{entry.label}</div>;
          if (entry.kind === "custom") return <div key={`c${index}`}>{entry.render()}</div>;
          const icon = typeof entry.icon === "string" ? <Icon name={entry.icon} /> : entry.icon;
          return (
            <button
              key={entry.id ?? `${entry.label}${index}`}
              type="button"
              role="menuitem"
              data-index={index}
              data-testid={entry.id ? `menu-${entry.id}` : undefined}
              className={`n-menu-item${index === active ? " is-active" : ""}${entry.danger ? " is-danger" : ""}${sub?.index === index ? " is-open" : ""}`}
              disabled={entry.disabled}
              onMouseEnter={(e) => {
                setActive(index);
                if (entry.submenu) setSub({ index, el: e.currentTarget });
                else if (sub) setSub(null);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => choose(index, e.currentTarget)}
            >
              {icon ? <span className="n-menu-icon">{icon}</span> : null}
              <span className="n-menu-label">
                {entry.label}
                {entry.detail ? <span className="n-menu-detail">{entry.detail}</span> : null}
              </span>
              {entry.trailing}
              {entry.hint ? <span className="n-menu-hint">{entry.hint}</span> : null}
              {entry.checked ? <Icon name="check" className="n-menu-check" /> : null}
              {entry.submenu ? <Icon name="chevronRight" className="n-menu-chevron" /> : null}
            </button>
          );
        })}
        {!visible.length ? <div className="n-menu-empty">No results</div> : null}
      </div>
      {footer}
      {sub && subEntry && isItem(subEntry) && subEntry.submenu ? (
        <Popover anchor={sub.el} placement="right-start" offset={2} onClose={() => setSub(null)}>
          <MenuList entries={subEntry.submenu()} onClose={() => { setSub(null); onClose(); }} />
        </Popover>
      ) : null}
    </div>
  );
}

export function Menu({ anchor, onClose, entries, placement, width = 260, search, searchPlaceholder, footer, testId }: { anchor: Anchor; onClose: () => void; entries: MenuEntry[]; placement?: Placement; width?: number; search?: boolean; searchPlaceholder?: string; footer?: ReactNode; testId?: string }) {
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} width={width} role="menu">
      <MenuList entries={entries} onClose={onClose} search={search} searchPlaceholder={searchPlaceholder} footer={footer} testId={testId} />
    </Popover>
  );
}

export function useMenu() {
  const [anchor, setAnchor] = useState<Anchor>(null);
  return { anchor, open: (a: Anchor) => setAnchor(a), close: () => setAnchor(null), isOpen: anchor !== null };
}
