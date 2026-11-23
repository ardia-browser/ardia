import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MenuItem } from "@ardia-real/shell";
import { useBrowser } from "../../../../../apps/browser/src/state/browser/store";
import { Symbol } from "./Symbol";

type OpenMenu = { items: MenuItem[]; x: number; y: number; resolve: (id: string | null) => void; onKeepOpenPick?: (id: string) => MenuItem[] };

let open: OpenMenu | null = null;
const watchers = new Set<() => void>();
const publish = (next: OpenMenu | null) => {
  open = next;
  for (const watcher of watchers) watcher();
};

const pointer = { x: 0, y: 0 };
let optionHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      optionHeld = e.altKey;
    },
    true,
  );
  for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (e) => (optionHeld = e.altKey), true);
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
const MENU_WIDTH = 240;
const EDGE = 8;
const SUB_OVERLAP = 4;

type ParentSpan = { left: number; right: number };

function MenuList({ items, x, y, parent }: { items: MenuItem[]; x: number; y: number; parent?: ParentSpan }) {
  const [sub, setSub] = useState<{ index: number; top: number; items: MenuItem[] } | null>(null);
  const [option, setOption] = useState(optionHeld);
  const [height, setHeight] = useState(0);
  const el = useRef<HTMLDivElement | null>(null);
  const dark = useBrowser((s) => s.ui.appDark);
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => setOption(e.altKey);
    const events = ["keydown", "keyup", "pointermove"] as const;
    for (const type of events) document.addEventListener(type, track);
    return () => {
      for (const type of events) document.removeEventListener(type, track);
    };
  }, []);
  useEffect(() => setSub(null), [items]);
  useLayoutEffect(() => {
    const next = el.current?.getBoundingClientRect().height ?? 0;
    if (next && next !== height) setHeight(next);
  }, [items, option]);
  const width = MENU_WIDTH;
  const left = parent
    ? parent.right - SUB_OVERLAP + width <= window.innerWidth - EDGE
      ? parent.right - SUB_OVERLAP
      : Math.max(EDGE, parent.left - width + SUB_OVERLAP)
    : Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
  const top = Math.max(EDGE, Math.min(y, window.innerHeight - Math.max(height, 40) - EDGE));
  return (
    <>
      <div ref={el} className={`ardia-menu${dark ? " dark" : ""}`} style={{ left, top, width }} onPointerDown={(e) => e.stopPropagation()}>
        {items.map((item, i) => {
          if ("separator" in item) return <div key={i} className="ardia-menu-separator" />;
          const next = items[i + 1];
          if (item.alternate ? !option : option && next && "id" in next && next.alternate) return null;
          const enabled = item.enabled !== false;
          return (
            <div
              key={item.id + i}
              className={`ardia-menu-item${enabled ? "" : " disabled"}`}
              onPointerEnter={(e) => setSub(item.children ? { index: i, top: (e.currentTarget as HTMLElement).getBoundingClientRect().top, items: item.children } : null)}
              onClick={() => enabled && !item.children && pick(item.id, item.keepOpen)}
            >
              <span className="ardia-menu-check">{item.checked ? "✓" : ""}</span>
              {item.symbol ? <Symbol name={item.symbol} size={12} color="currentColor" style={{ width: 16, height: 16, marginRight: 6 }} /> : null}
              {item.swatch ? <span className="ardia-menu-swatch" style={{ background: item.swatch }} /> : null}
              <span className="ardia-menu-title">{item.title}</span>
              <span className="ardia-menu-key">{item.children ? "›" : item.key ? `${(item.modifiers ?? []).map((m) => KEYS[m]).join("")}${item.key.toUpperCase()}` : ""}</span>
            </div>
          );
        })}
      </div>
      {sub ? <MenuList items={sub.items} x={left + width - SUB_OVERLAP} y={sub.top - 5} parent={{ left, right: left + width }} /> : null}
    </>
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
  return menu ? <MenuList items={menu.items} x={menu.x} y={menu.y} /> : null;
}
