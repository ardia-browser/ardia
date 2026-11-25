import { useLayoutEffect, useRef } from "react";
import { View, type ViewProps } from "react-native";

export type EdgeFadeMaskProps = ViewProps & { fadeWidth: number; floor: number; onset: number };

const ramp = (x: number) => Math.max(0, Math.min(1, x));

function firstScroller(root: HTMLElement): HTMLElement | null {
  const queue = [...root.children] as HTMLElement[];
  while (queue.length) {
    const node = queue.shift()!;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow === "auto" || overflow === "scroll") return node;
    queue.push(...([...node.children] as HTMLElement[]));
  }
  return null;
}

export function EdgeFadeMask({ fadeWidth, floor, onset, ...props }: EdgeFadeMaskProps) {
  const box = useRef<View>(null);
  useLayoutEffect(() => {
    const root = box.current as unknown as HTMLElement | null;
    if (!root) return;
    let scroller: HTMLElement | null = null;
    let shown = "";
    const apply = () => {
      const width = root.clientWidth;
      const offset = scroller?.scrollLeft ?? 0;
      const last = scroller ? Math.max(0, scroller.scrollWidth - scroller.clientWidth) : 0;
      const left = onset > 0 ? ramp(offset / onset) : 0;
      const right = onset > 0 ? ramp((last - offset) / onset) : 0;
      const edge = Math.min(width / 2, fadeWidth);
      const alpha = (strength: number) => +(1 - (1 - floor) * strength).toFixed(4);
      const mask = (left > 0 || right > 0) && width > 0 ? `linear-gradient(to right, rgba(0,0,0,${alpha(left)}) 0, #000 ${edge}px, #000 calc(100% - ${edge}px), rgba(0,0,0,${alpha(right)}) 100%)` : "";
      if (mask === shown) return;
      shown = mask;
      root.style.setProperty("mask-image", mask || null);
      root.style.setProperty("-webkit-mask-image", mask || null);
    };
    const sizes = new ResizeObserver(() => {
      watch();
      apply();
    });
    const watch = () => {
      const next = firstScroller(root);
      if (next === scroller) return;
      scroller?.removeEventListener("scroll", apply);
      if (scroller) sizes.unobserve(scroller);
      if (scroller?.firstElementChild) sizes.unobserve(scroller.firstElementChild);
      scroller = next;
      scroller?.addEventListener("scroll", apply, { passive: true });
      if (scroller) sizes.observe(scroller);
      if (scroller?.firstElementChild) sizes.observe(scroller.firstElementChild);
      apply();
    };
    sizes.observe(root);
    watch();
    return () => {
      sizes.disconnect();
      scroller?.removeEventListener("scroll", apply);
    };
  }, [fadeWidth, floor, onset]);
  return <View {...props} ref={box} />;
}
