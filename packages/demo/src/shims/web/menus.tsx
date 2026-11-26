import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { MenuItem } from "@ardia-real/shell";
import { useBrowser } from "../../../../../apps/browser/src/state/browser/store";
import { Symbol } from "./Symbol";
import { placeMenu } from "./menuPlacement";

type OpenMenu = { items: MenuItem[]; x: number; y: number; resolve: (id: string | null) => void; onKeepOpenPick?: (id: string) => MenuItem[] };

let open: OpenMenu | null = null;
const watchers = new Set<() => void>();
const publish = (next: OpenMenu | null) => {
  open = next;
  for (const watcher of watchers) watcher();
};

const pointer = { x: 0, y: 0 };
let commandHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      commandHeld = e.metaKey;
    },
    true,
  );
  for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (e) => (commandHeld = e.metaKey), true);
}

export function showMenu(items: MenuItem[], onKeepOpenPick?: (id: string) => MenuItem[]): Promise<string | null> {
  open?.resolve(null);
  return new Promise((resolve) => publish({ items, x: pointer.x, y: pointer.y, resolve, onKeepOpenPick }));
}

const pick = (id: string, keepOpen?: boolean) => {
  if (keepOpen && open?.onKeepOpenPick) publish({ ...open, items: open.onKeepOpenPick(id) });
  else close(id);
};

const close = (id: string | null) => {
  const menu = open;
  publish(null);
  menu?.resolve(id);
};

const KEYS: Record<string, string> = { command: "⌘", shift: "⇧", option: "⌥", control: "⌃" };

type ListAnchor = { x: number; y: number } | { row: HTMLElement };

function MenuList({ items, anchor }: { items: MenuItem[]; anchor: ListAnchor }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [sub, setSub] = useState<{ index: number; row: HTMLElement } | null>(null);
  const [command, setCommand] = useState(commandHeld);
  const dark = useBrowser((s) => s.ui.appDark);
  useLayoutEffect(() => {
    const place = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const { width, height } = menu.getBoundingClientRect();
      const parent = "row" in anchor ? anchor.row.closest(".ardia-menu")?.getBoundingClientRect() : null;
      const next = placeMenu(
        { width, height },
        "row" in anchor && parent ? { row: anchor.row.getBoundingClientRect(), parent } : "row" in anchor ? { x: anchor.row.getBoundingClientRect().right, y: anchor.row.getBoundingClientRect().top } : anchor,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition((previous) => (previous.left === next.left && previous.top === next.top ? previous : next));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, command, items]);
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => setCommand(e.metaKey);
    const events = ["keydown", "keyup", "pointermove"] as const;
    for (const type of events) document.addEventListener(type, track);
    return () => {
      for (const type of events) document.removeEventListener(type, track);
    };
  }, []);
  return createPortal(
    <div ref={menuRef} className={`ardia-menu${dark ? " dark" : ""}`} style={{ ...position, width: 240, maxHeight: "calc(100vh - 16px)", overflowY: "auto" }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        if ("separator" in item) return <div key={i} className="ardia-menu-separator" />;
        const next = items[i + 1];
        if (item.alternate ? !command : command && next && "id" in next && next.alternate) return null;
        const enabled = item.enabled !== false;
        return (
          <div
            key={item.id + i}
            className={`ardia-menu-item${enabled ? "" : " disabled"}${sub?.index === i ? " expanded" : ""}`}
            onPointerEnter={(e) => setSub(enabled && item.children ? { index: i, row: e.currentTarget } : null)}
            onClick={(e) => {
              e.stopPropagation();
              if (enabled && !item.children) pick(item.id, item.keepOpen);
            }}
          >
            <span className="ardia-menu-check">{item.checked ? "✓" : ""}</span>
            {item.symbol ? <Symbol name={item.symbol} size={12} color="currentColor" style={{ width: 16, height: 16, marginRight: 6 }} /> : null}
            {item.swatch ? <span className="ardia-menu-swatch" style={{ background: item.swatch }} /> : null}
            <span className="ardia-menu-title">{item.title}</span>
            <span className="ardia-menu-key">{item.children ? "›" : item.key ? `${(item.modifiers ?? []).map((m) => KEYS[m]).join("")}${item.key.toUpperCase()}` : ""}</span>
            {sub?.index === i && item.children ? <MenuList items={item.children} anchor={{ row: sub.row }} /> : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function MenuHost() {
  const menu = useSyncExternalStore(
    (watch) => (watchers.add(watch), () => void watchers.delete(watch)),
    () => open,
  );
  useEffect(() => {
    if (!menu) return;
    const outside = () => close(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  return menu ? <MenuList key={`${menu.x},${menu.y}`} items={menu.items} anchor={{ x: menu.x, y: menu.y }} /> : null;
}
