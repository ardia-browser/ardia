import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { MenuItem } from "@ardia-real/shell";
import { useBrowser } from "../../browser/src/state/browser/store";
import { Symbol } from "./shims/web/Symbol";
import { formatShortcut } from "./shortcutFormat";
import { heldModifiers, type MenuModifier } from "./clickModifiers";
import { useInputRegion } from "./shellAbove";
import { useGlassPanel } from "./shellGlass";
import { watchPageFocus } from "./pageFocus";
import { withShareMenus } from "./linkShare";

type OpenMenu = { items: MenuItem[]; x: number; y: number; resolve: (id: string | null) => void; onKeepOpenPick?: (id: string) => MenuItem[] };

export function alternateShown(primary: MenuItem | undefined, alternate: MenuItem, held: ReadonlySet<MenuModifier>): boolean {
  const base = new Set(primary && "id" in primary ? primary.modifiers ?? [] : []);
  const own = "id" in alternate ? alternate.modifiers ?? [] : [];
  const extra = own.filter((modifier) => !base.has(modifier));
  return (extra.length ? extra : ["command" as const]).every((modifier) => held.has(modifier));
}

let open: OpenMenu | null = null;
export const menuShown = () => open !== null;
export const shownMenu = () => open && { items: open.items, x: open.x, y: open.y };

export const hasSymbolColumn = (items: readonly MenuItem[]) => items.some((item) => !("separator" in item) && (!!item.symbol || !!item.swatch));
const CLEAR_HEX = /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i;
export function menuSwatch(item: MenuItem, dark: boolean): { fill: string | null } | null {
  if ("separator" in item || !item.swatch) return null;
  const color = dark && item.swatchDark ? item.swatchDark : item.swatch;
  return { fill: CLEAR_HEX.test(color) || color === "transparent" ? null : color };
}
const watchers = new Set<() => void>();
export const watchMenus = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
let stopPageFocus: (() => void) | null = null;
const publish = (next: OpenMenu | null) => {
  open = next;
  if (next) stopPageFocus ??= watchPageFocus(() => close(null));
  else {
    stopPageFocus?.();
    stopPageFocus = null;
  }
  for (const watcher of watchers) watcher();
};

const pointer = { x: 0, y: 0 };
let held: ReadonlySet<MenuModifier> = new Set();
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      held = heldModifiers(e);
    },
    true,
  );
  for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (e) => (held = heldModifiers(e)), true);
}

type MenuPoint = { x: number; y: number };
type KeepOpenPick = (id: string) => MenuItem[];

export function showMenu(items: MenuItem[], pickOrPoint?: KeepOpenPick | MenuPoint, point?: MenuPoint): Promise<string | null> {
  const onKeepOpenPick = typeof pickOrPoint === "function" ? pickOrPoint : undefined;
  const at = (typeof pickOrPoint === "object" && pickOrPoint) || point || pointer;
  open?.resolve(null);
  return new Promise((resolve) => publish({ items: withShareMenus(items), x: at.x, y: at.y, resolve, onKeepOpenPick }));
}

export const pickMenuItem = (id: string, keepOpen?: boolean) => {
  if (keepOpen && open?.onKeepOpenPick) publish({ ...open, items: withShareMenus(open.onKeepOpenPick(id)) });
  else close(id);
};

const sameItem = (a: MenuItem | undefined, b: MenuItem) => !!a && "id" in a && "id" in b && a.id === b.id;

const close = (id: string | null) => {
  const menu = open;
  publish(null);
  menu?.resolve(id);
};

export const dismissMenu = () => {
  if (open) close(null);
};

export function menuButtonPresses(show: () => void) {
  let openAtPointerDown = false;
  return {
    pointerDown: () => void (openAtPointerDown = menuShown()),
    click: () => {
      const wasOpen = openAtPointerDown || menuShown();
      openAtPointerDown = false;
      if (!wasOpen) show();
      else if (open) close(null);
    },
  };
}

type MenuAnchor = { x: number; y: number } | { row: HTMLElement };

function MenuList({ items, anchor }: { items: MenuItem[]; anchor: MenuAnchor }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useGlassPanel(menuRef);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [sub, setSub] = useState<{ item: MenuItem; row: HTMLElement } | null>(null);
  const [modifiers, setModifiers] = useState(held);
  const dark = useBrowser((s) => s.ui.appDark);
  useLayoutEffect(() => {
    const place = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const { width, height } = menu.getBoundingClientRect();
      let left: number;
      let top: number;
      if ("row" in anchor) {
        const row = anchor.row.getBoundingClientRect();
        const parent = anchor.row.closest(".ardia-menu")!.getBoundingClientRect();
        left = parent.right - 4;
        top = row.top - 5;
        if (left + width > window.innerWidth - 8) left = parent.left - width + 4;
      } else {
        left = anchor.x;
        top = anchor.y;
      }
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, modifiers, items]);
  useInputRegion(menuRef);
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => {
      const next = heldModifiers(e);
      setModifiers((previous) => (previous.size === next.size && [...next].every((modifier) => previous.has(modifier)) ? previous : next));
    };
    const events = ["keydown", "keyup", "pointermove"] as const;
    for (const type of events) document.addEventListener(type, track);
    return () => {
      for (const type of events) document.removeEventListener(type, track);
    };
  }, []);
  const symbols = hasSymbolColumn(items);
  return createPortal(
    <div ref={menuRef} className={`ardia-menu${dark ? " dark" : ""}`} style={{ ...position, width: "max-content", minWidth: 240, maxWidth: "min(420px, calc(100vw - 26px))", maxHeight: "calc(100vh - 26px)", overflowY: "auto" }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        if ("separator" in item) return <div key={i} className="ardia-menu-separator" />;
        const next = items[i + 1];
        if (item.alternate ? !alternateShown(items[i - 1], item, modifiers) : next && "id" in next && next.alternate && alternateShown(item, next, modifiers)) return null;
        const enabled = item.enabled !== false;
        const swatch = item.symbol ? null : menuSwatch(item, dark);
        return (
          <div
            key={item.id + i}
            className={`ardia-menu-item${enabled ? "" : " disabled"}${sameItem(sub?.item, item) ? " expanded" : ""}`}
            onPointerEnter={(e) => setSub(enabled && item.children ? { item, row: e.currentTarget } : null)}
            onClick={() => enabled && !item.children && pickMenuItem(item.id, item.keepOpen)}
          >
            <span className="ardia-menu-check">{item.checked ? "✓" : ""}</span>
            {item.symbol ? <Symbol name={item.symbol} size={12} color="currentColor" style={{ width: 16, height: 16, marginRight: 6 }} /> : swatch ? (
              <span className="ardia-menu-swatch-cell">
                <span className={`ardia-menu-swatch${swatch.fill ? "" : " empty"}`} style={swatch.fill ? { background: swatch.fill } : undefined} />
              </span>
            ) : symbols ? <span className="ardia-menu-symbol-gap" style={{ width: 16, marginRight: 6, flex: "none" }} /> : null}
            <span className="ardia-menu-title">{item.title}</span>
            <span className="ardia-menu-key">{item.children ? "›" : item.key ? formatShortcut({ key: item.key, modifiers: item.modifiers ?? [] }) : ""}</span>
            {sub && sameItem(sub.item, item) && item.children ? <MenuList items={item.children} anchor={{ row: sub.row }} /> : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function claimMenuEscape(e: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation" | "stopImmediatePropagation">, closeMenu: () => void): boolean {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  e.stopPropagation();
  closeMenu();
  return true;
}

export function MenuHost() {
  const menu = useSyncExternalStore(
    watchMenus,
    () => open,
  );
  useEffect(() => {
    if (!menu) return;
    const outside = () => close(null);
    const key = (e: KeyboardEvent) => claimMenuEscape(e, () => close(null));
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  return menu ? <MenuList items={menu.items} anchor={{ x: menu.x, y: menu.y }} /> : null;
}
