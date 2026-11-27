import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Color } from "../../shared/database";
import { Icon } from "./icons";
import { ghostOut, MOTION } from "../ui/motion";

type Layer = { id: number; el: HTMLElement | null; close: () => void };
const layers: Layer[] = [];
let layerSeq = 0;
let listening = false;

function onPointerDown(event: PointerEvent) {
  if (!layers.length) return;
  const target = event.target as Node | null;
  let deepest = -1;
  for (let i = layers.length - 1; i >= 0; i--) {
    if (target && layers[i]!.el?.contains(target)) {
      deepest = i;
      break;
    }
  }
  const anchorHit = target instanceof Element && target.closest("[data-db-anchor-open]");
  const doomed = layers.slice(deepest + 1);
  if (anchorHit && deepest === -1 && doomed.length === 1) return;
  for (const layer of doomed.reverse()) layer.close();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !layers.length) return;
  event.preventDefault();
  event.stopPropagation();
  layers[layers.length - 1]!.close();
}

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}

export const anyLayerOpen = () => layers.length > 0;

export type Anchor = { x: number; y: number; w?: number; h?: number } | HTMLElement | null;

function rectOf(anchor: Anchor): DOMRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return new DOMRect(anchor.x, anchor.y, anchor.w ?? 0, anchor.h ?? 0);
}

export function Popover({
  anchor,
  onClose,
  children,
  placement = "bottom-start",
  width,
  className,
  style,
  offset = 4,
  cover = false,
  testId,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-start" | "bottom-end" | "right-start" | "top-start" | "over";
  width?: number | "anchor";
  className?: string;
  style?: CSSProperties;
  offset?: number;
  cover?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const popRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    if (!el) return undefined;
    return () => ghostOut(el, "is-leaving", MOTION.exit);
  }, []);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; side: string; align: string } | null>(null);
  useLayoutEffect(() => {
    listen();
    const layer: Layer = { id: ++layerSeq, el: ref.current, close: () => closeRef.current() };
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, []);
  const place = useCallback(() => {
    const el = ref.current;
    const r = rectOf(anchor);
    if (!el || !r) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left;
    let top = r.bottom + offset;
    if (placement === "bottom-end") left = r.right - w;
    if (placement === "right-start") {
      left = r.right + offset;
      top = r.top - 6;
      if (left + w > vw - 8) left = r.left - w - offset;
    }
    if (placement === "top-start") top = r.top - h - offset;
    if (placement === "over" || cover) {
      top = r.top;
      left = r.left;
    }
    if (placement !== "right-start" && placement !== "over" && !cover && top + h > vh - 8 && r.top - h - offset > 8) top = r.top - h - offset;
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - Math.min(h, vh - 16) - 8));
    setPos({ left, top, maxHeight: vh - 16, side: placement === "right-start" ? "right" : top < r.top ? "top" : "bottom", align: placement === "bottom-end" ? "end" : "start" });
  }, [anchor, placement, offset, cover]);
  useLayoutEffect(() => {
    place();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);
  const anchorWidth = width === "anchor" ? rectOf(anchor)?.width : width;
  return createPortal(
    <div
      ref={popRef}
      data-side={pos?.side}
      data-align={pos?.align}
      className={`db-root db-pop ${className ?? ""}`}
      data-testid={testId}
      style={{ ...(anchorWidth ? { width: anchorWidth } : {}), ...style, left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function usePopover<T = true>() {
  const [state, setState] = useState<{ anchor: Anchor; value: T } | null>(null);
  const open = useCallback((anchor: Anchor, value?: T) => setState({ anchor, value: (value ?? true) as T }), []);
  const close = useCallback(() => setState(null), []);
  const toggle = useCallback((anchor: Anchor, value?: T) => setState((s) => (s ? null : { anchor, value: (value ?? true) as T })), []);
  return { state, open, close, toggle, isOpen: state !== null };
}

type MenuCtx = { active: number; setActive: (i: number) => void; register: (el: HTMLElement) => number };
const MenuContext = createContext<MenuCtx | null>(null);

export function Menu({ children, className, style, autoFocus = true, testId }: { children: ReactNode; className?: string; style?: CSSProperties; autoFocus?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);
  const items = () => (ref.current ? [...ref.current.querySelectorAll<HTMLElement>("[data-menu-item]:not([data-disabled])")] : []);
  useEffect(() => {
    if (autoFocus && !ref.current?.querySelector("input,textarea")) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const ctx = useMemo<MenuCtx>(() => ({ active, setActive, register: () => -1 }), [active]);
  return (
    <MenuContext.Provider value={ctx}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`db-menu ${className ?? ""}`}
        style={style}
        data-testid={testId}
        onKeyDown={(e) => {
          const list = items();
          if (!list.length) return;
          const current = list.findIndex((el) => el.classList.contains("is-active"));
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = e.key === "ArrowDown" ? (current + 1) % list.length : (current - 1 + list.length) % list.length;
            list.forEach((el, i) => el.classList.toggle("is-active", i === next));
            list[next]!.scrollIntoView({ block: "nearest" });
          } else if (e.key === "Enter" && current >= 0 && !(e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault();
            list[current]!.click();
          }
        }}
        onMouseMove={(e) => {
          const item = (e.target as HTMLElement).closest<HTMLElement>("[data-menu-item]");
          if (!item) return;
          for (const el of items()) el.classList.toggle("is-active", el === item);
        }}
        onMouseLeave={() => {
          for (const el of items()) el.classList.remove("is-active");
        }}
      >
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export function MenuItem({
  icon,
  label,
  right,
  onSelect,
  danger,
  disabled,
  checked,
  chevron,
  testId,
  children,
  className,
  onPointerDownSelect,
}: {
  icon?: ReactNode;
  label?: ReactNode;
  right?: ReactNode;
  onSelect?: (el: HTMLElement) => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  chevron?: boolean;
  testId?: string;
  children?: ReactNode;
  className?: string;
  onPointerDownSelect?: boolean;
}) {
  useContext(MenuContext);
  return (
    <div
      role="menuitem"
      data-menu-item=""
      data-testid={testId}
      {...(disabled ? { "data-disabled": "" } : {})}
      className={`db-item ${danger ? "is-danger" : ""} ${disabled ? "is-disabled" : ""} ${className ?? ""}`}
      onPointerDown={(e) => {
        if (onPointerDownSelect && !disabled && e.button === 0) {
          e.preventDefault();
          onSelect?.(e.currentTarget);
        }
      }}
      onClick={(e) => {
        if (disabled || onPointerDownSelect) return;
        onSelect?.(e.currentTarget);
      }}
    >
      {icon !== undefined && <span className="db-item-icon">{typeof icon === "string" ? <Icon name={icon} /> : icon}</span>}
      <span className="db-item-label">{label ?? children}</span>
      {right !== undefined && <span className="db-item-right">{right}</span>}
      {checked && <Icon name="check" className="db-item-check" />}
      {chevron && <Icon name="chevronRight" className="db-item-chevron" size={14} />}
    </div>
  );
}

export const MenuSeparator = () => <div className="db-sep" />;
export const MenuLabel = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="db-menu-label">
    <span>{children}</span>
    {right}
  </div>
);

export function Toggle({ on, onChange, testId }: { on: boolean; onChange: (on: boolean) => void; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid={testId}
      className={`db-toggle ${on ? "is-on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}

export function Tag({ color, children, onRemove, className, testId }: { color: Color; children: ReactNode; onRemove?: () => void; className?: string; testId?: string }) {
  return (
    <span className={`db-tag c-${color} ${className ?? ""}`} data-testid={testId}>
      <span className="db-tag-text">{children}</span>
      {onRemove && (
        <span
          className="db-tag-x"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="x" size={10} strokeWidth={1.8} />
        </span>
      )}
    </span>
  );
}

export function StatusDot({ color }: { color: Color }) {
  return <span className={`db-status-dot c-${color}`} />;
}

export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  autoFocus,
  className,
  testId,
  selectAll,
  onKeyDown,
  type = "text",
}: {
  value: string;
  onChange?: (v: string) => void;
  onCommit?: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  testId?: string;
  selectAll?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  type?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus({ preventScroll: true });
      if (selectAll) ref.current?.select();
    }
  }, [autoFocus, selectAll]);
  return (
    <input
      ref={ref}
      type={type}
      className={`db-input ${className ?? ""}`}
      data-testid={testId}
      value={draft}
      placeholder={placeholder}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange?.(e.target.value);
      }}
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onCommit?.(draft);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter") {
          e.preventDefault();
          if (draft !== value) onCommit?.(draft);
          editing.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function useOutsideClick(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.(".db-pop")) onOutside();
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [ref, onOutside, active]);
}

export type DragState = { id: string; x: number; y: number; dx: number; dy: number; started: boolean };

export function startDrag(
  event: React.PointerEvent | PointerEvent,
  handlers: { onStart?: () => void; onMove: (e: PointerEvent, delta: { dx: number; dy: number }) => void; onEnd: (e: PointerEvent, moved: boolean) => void; threshold?: number },
) {
  const startX = event.clientX;
  const startY = event.clientY;
  const threshold = handlers.threshold ?? 4;
  let started = false;
  const move = (e: PointerEvent) => {
    if (e.buttons === 0) {
      up(e);
      return;
    }
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!started && Math.hypot(dx, dy) < threshold) return;
    if (!started) {
      started = true;
      document.body.classList.add("db-dragging");
      handlers.onStart?.();
    }
    e.preventDefault();
    handlers.onMove(e, { dx, dy });
  };
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("db-dragging");
    handlers.onEnd(e, started);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

export function DragGhost({ x, y, children, width }: { x: number; y: number; children: ReactNode; width?: number }) {
  return createPortal(
    <div className="db-root db-ghost" style={{ left: x, top: y, width }}>
      {children}
    </div>,
    document.body,
  );
}

export function Button({ children, onClick, kind = "plain", className, testId, title, icon, disabled }: { children?: ReactNode; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; kind?: "plain" | "primary" | "ghost" | "danger"; className?: string; testId?: string; title?: string; icon?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`db-btn is-${kind} ${className ?? ""}`} data-testid={testId} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export function IconButton({ icon, onClick, title, testId, className, active, size = 16, onPointerDown }: { icon: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; title: string; testId?: string; className?: string; active?: boolean; size?: number; onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`db-icon-btn ${active ? "is-active" : ""} ${className ?? ""}`} title={title} aria-label={title} data-testid={testId} onClick={onClick} onPointerDown={onPointerDown}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Avatar({ name, color, size = 20 }: { name: string; color: string; size?: number }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="db-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.55), background: /^#[0-9a-fA-F]{3,8}$|^rgb/.test(color) ? color : "#888" }}>
      {initial}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="db-seg" data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.id} className={o.id === value ? "is-on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}
