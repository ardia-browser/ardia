import { autoUpdate, flip, offset as offsetMiddleware, shift, size, useFloating, type Placement } from "@floating-ui/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ghostOut, MOTION } from "./motion";

export type Anchor = HTMLElement | DOMRect | { x: number; y: number } | null;

const stack: number[] = [];
let nextId = 1;

function virtualFrom(anchor: Anchor) {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor;
  const rect = "width" in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
  return { getBoundingClientRect: () => rect };
}

export function Popover({
  anchor,
  onClose,
  placement = "bottom-start",
  offset = 4,
  children,
  className,
  style,
  width,
  maxHeight = 440,
  closeOnOutside = true,
  role = "dialog",
  label,
}: {
  anchor: Anchor;
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  width?: number;
  maxHeight?: number;
  closeOnOutside?: boolean;
  role?: string;
  label?: string;
}) {
  const [id] = useState(() => nextId++);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { refs, floatingStyles, placement: finalPlacement } = useFloating({
    placement,
    strategy: "fixed",
    transform: false,
    middleware: [
      offsetMiddleware(offset),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(maxHeight, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const floatingRef = useCallback(
    (el: HTMLDivElement | null) => {
      refs.setFloating(el);
      if (!el) return undefined;
      return () => ghostOut(el, "is-leaving", MOTION.exit);
    },
    [refs],
  );

  useLayoutEffect(() => {
    const reference = virtualFrom(anchor);
    if (reference) refs.setPositionReference(reference);
  }, [anchor, refs]);

  useEffect(() => {
    stack.push(id);
    const onDown = (event: MouseEvent) => {
      if (!closeOnOutside) return;
      const target = event.target as Node;
      const depth = stack.indexOf(id);
      const inside = [...document.querySelectorAll<HTMLElement>("[data-popover-id]")].some((el) => stack.indexOf(Number(el.dataset.popoverId)) >= depth && el.contains(target));
      const current = anchorRef.current;
      if (inside || (current instanceof HTMLElement && current.contains(target))) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stack.at(-1) === id) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [id, closeOnOutside]);

  return createPortal(
    <div
      ref={floatingRef}
      data-popover-id={id}
      data-side={finalPlacement.split("-")[0]}
      data-align={finalPlacement.split("-")[1] ?? "center"}
      role={role}
      aria-label={label}
      className={className ? `n-popover ${className}` : "n-popover"}
      style={{ ...floatingStyles, width, ...style }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function isTopPopover(): boolean {
  return stack.length > 0;
}

export function topPopoverId(): number | undefined {
  return stack.at(-1);
}

export function useIsTop(): () => boolean {
  const [id] = useState(() => stack.at(-1));
  return () => stack.at(-1) === id;
}
