import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export const MOTION = { hover: 90, fast: 120, base: 160, exit: 90, slow: 260, slower: 320 } as const;
export const EASE = { out: "cubic-bezier(0.2, 0, 0, 1)", in: "cubic-bezier(0.4, 0, 1, 1)", std: "cubic-bezier(0.2, 0, 0.2, 1)", soft: "cubic-bezier(0.32, 0.72, 0, 1)" } as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function usePresence(open: boolean, exitMs: number = MOTION.base): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => clearTimeout(timer);
  }, [open]);
  return { mounted: open || mounted, closing: !open && closing };
}

export function useClosingFocus<T extends HTMLElement>(closing: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!closing || !el || !el.contains(document.activeElement)) return;
    const back = opener.current;
    if (back instanceof HTMLElement && back.isConnected && !el.contains(back)) back.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }, [closing]);
  return ref;
}

export const GHOST_MAX_NODES = 1500;

type GhostOptions = { force?: boolean; prune?: string; onGhost?: (ghost: HTMLElement) => void };

function cloneVisible(el: HTMLElement, prune: string, top: number, bottom: number): HTMLElement {
  const copy = (node: Node): Node => {
    if (!(node instanceof HTMLElement)) return node.cloneNode(true);
    const out = node.cloneNode(false) as HTMLElement;
    let skipped: { first: HTMLElement; height: number } | null = null;
    const flush = (until: HTMLElement | null) => {
      if (!skipped) return;
      const start = skipped.first.getBoundingClientRect().top;
      const end = until ? until.getBoundingClientRect().top : start + skipped.height;
      const spacer = document.createElement("div");
      spacer.style.height = `${Math.max(0, end - start)}px`;
      out.append(spacer);
      skipped = null;
    };
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.matches(prune)) {
        const r = child.getBoundingClientRect();
        if (r.bottom < top || r.top > bottom) {
          if (skipped) skipped.height = r.bottom - skipped.first.getBoundingClientRect().top;
          else skipped = { first: child, height: r.height };
          continue;
        }
        flush(child);
      }
      out.append(copy(child));
    }
    flush(null);
    return out;
  };
  return copy(el) as HTMLElement;
}

export function ghostOut(el: Element | null, className = "is-leaving", ms: number = MOTION.exit, options: GhostOptions = {}) {
  if (!(el instanceof HTMLElement) || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pruned = options.prune ? cloneVisible(el, options.prune, Math.max(0, rect.top) - 200, Math.min(innerHeight, rect.bottom) + 200) : null;
  if ((pruned ?? el).getElementsByTagName("*").length > GHOST_MAX_NODES) return;
  const parent = el.parentElement;
  const scrollTop = el.scrollTop;
  const style = getComputedStyle(el);
  const zIndex = style.zIndex === "auto" ? "1000" : style.zIndex;
  queueMicrotask(() => {
    if (!options.force && !parent?.isConnected) return;
    const ghost = pruned ?? (el.cloneNode(true) as HTMLElement);
    ghost.removeAttribute("id");
    ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.removeAttribute("data-testid");
    ghost.querySelectorAll("[data-testid]").forEach((n) => n.removeAttribute("data-testid"));
    ghost.removeAttribute("data-popover-id");
    for (const attr of ["placeholder", "aria-label", "role", "name", "title"]) {
      ghost.removeAttribute(attr);
      ghost.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr));
    }
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      transform: "none",
      pointerEvents: "none",
      zIndex,
      animationDuration: `${ms}ms`,
    });
    ghost.classList.add("n-ghost", className);
    document.body.append(ghost);
    if (scrollTop) ghost.scrollTop = scrollTop;
    options.onGhost?.(ghost);
    ghost.addEventListener("animationend", (event) => event.target === ghost && ghost.remove());
    if (!ghost.getAnimations().length) {
      ghost.remove();
      return;
    }
    setTimeout(() => ghost.remove(), ms + 600);
  });
}

const crossfadeRefs = new Map<string, (el: HTMLElement | null) => (() => void) | undefined>();

function settleMatches(ghost: HTMLElement, live: HTMLElement, parts: string, ms: number) {
  const key = (n: Element) => `${n.textContent ?? ""}@${Math.round(n.getBoundingClientRect().left)}`;
  const old = new Map<string, HTMLElement>();
  ghost.querySelectorAll<HTMLElement>(parts).forEach((n) => old.set(key(n), n));
  live.querySelectorAll<HTMLElement>(parts).forEach((n) => {
    const twin = old.get(key(n));
    if (twin) twin.style.visibility = "hidden";
    else n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: EASE.out });
  });
}

export function crossfadeRef<T extends HTMLElement>(live: string, parts: string, ms: number = MOTION.fast): (el: T | null) => (() => void) | undefined {
  const id = `${live}|${parts}|${ms}`;
  let ref = crossfadeRefs.get(id);
  if (!ref) {
    ref = (el: HTMLElement | null) => {
      if (!el) return undefined;
      return () =>
        ghostOut(el, "is-fading", ms, {
          force: true,
          onGhost: (ghost) => {
            const next = [...document.querySelectorAll<HTMLElement>(live)].find((n) => n !== el && !n.closest(".n-ghost"));
            if (next) settleMatches(ghost, next, parts, ms);
          },
        });
    };
    crossfadeRefs.set(id, ref);
  }
  return ref as (el: T | null) => (() => void) | undefined;
}

const exitRefs = new Map<string, (el: HTMLElement | null) => (() => void) | undefined>();

export function retireOtherMenus(current: HTMLElement, selector = ".n-slash") {
  if (current.classList.contains("is-retired") && !current.classList.contains("n-ghost")) {
    current.classList.remove("is-retired");
    current.removeAttribute("inert");
    current.removeAttribute("aria-hidden");
    if (current.dataset.retiredRole) current.setAttribute("role", current.dataset.retiredRole);
    if (current.dataset.retiredTestid) current.setAttribute("data-testid", current.dataset.retiredTestid);
  }
  document.querySelectorAll<HTMLElement>(selector).forEach((menu) => {
    if (menu === current || menu.classList.contains("is-retired") || menu.hasAttribute("inert")) return;
    const role = menu.getAttribute("role");
    const testid = menu.getAttribute("data-testid");
    if (role) menu.dataset.retiredRole = role;
    if (testid) menu.dataset.retiredTestid = testid;
    menu.classList.add("is-retired");
    menu.setAttribute("inert", "");
    menu.setAttribute("aria-hidden", "true");
    menu.removeAttribute("role");
    menu.removeAttribute("data-testid");
  });
}

export function exitRef<T extends HTMLElement>(className = "is-leaving", ms: number = MOTION.exit): (el: T | null) => (() => void) | undefined {
  const key = `${className}:${ms}`;
  let ref = exitRefs.get(key);
  if (!ref) {
    ref = (el: HTMLElement | null) => {
      if (!el) return undefined;
      return () => ghostOut(el, className, ms);
    };
    exitRefs.set(key, ref);
  }
  return ref as (el: T | null) => (() => void) | undefined;
}

type Rects = Map<string, DOMRect>;

function scrollShift(container: ParentNode | null, scroller?: string): [number, number] {
  const box = container instanceof HTMLElement ? container : null;
  const origin = box?.getBoundingClientRect();
  const base: [number, number] = box && origin ? [box.scrollLeft - origin.left, box.scrollTop - origin.top] : [0, 0];
  const el = !scroller || !container ? null : box && box.matches(scroller) ? null : container.querySelector<HTMLElement>(scroller);
  return el ? [base[0] + el.scrollLeft, base[1] + el.scrollTop] : base;
}

function placed(el: HTMLElement, [sx, sy]: [number, number]): DOMRect {
  const rect = el.getBoundingClientRect();
  return sx || sy ? new DOMRect(rect.x + sx, rect.y + sy, rect.width, rect.height) : rect;
}

export function measure(container: ParentNode | null, selector: string, key: string, scroller?: string): Rects {
  const out: Rects = new Map();
  if (!container) return out;
  const shift = scrollShift(container, scroller);
  container.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const id = el.getAttribute(key);
    if (id && !out.has(id)) out.set(id, placed(el, shift));
  });
  return out;
}

type FlipOptions = { enter?: boolean | ((el: HTMLElement) => boolean); duration?: number; enterShift?: number; skip?: boolean; scroller?: string };

export function animateEnter(el: HTMLElement, shift = -4, ms: number = MOTION.base) {
  const reduced = reducedMotion();
  return el.animate([{ opacity: 0, transform: reduced || !shift ? "none" : `translateY(${shift}px)` }, { opacity: 1, transform: "none" }], { duration: ms, easing: EASE.out });
}

function inflight(el: HTMLElement): [number, number] {
  const anims = el.getAnimations().filter((a) => a.id === "flip" && a.playState !== "finished");
  if (!anims.length) return [0, 0];
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform);
  return [m.e, m.f];
}

export function playFlip(container: ParentNode | null, selector: string, key: string, before: Rects, options: FlipOptions = {}): Rects {
  const out: Rects = new Map();
  if (!container) return out;
  const duration = options.duration ?? MOTION.base;
  const reduced = reducedMotion();
  const shift = scrollShift(container, options.scroller);
  const items: { el: HTMLElement; id: string; next: DOMRect; offset: [number, number] }[] = [];
  container.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const id = el.getAttribute(key);
    if (!id || out.has(id)) return;
    const offset = inflight(el);
    const rect = placed(el, shift);
    const next = offset[0] || offset[1] ? new DOMRect(rect.x - offset[0], rect.y - offset[1], rect.width, rect.height) : rect;
    out.set(id, next);
    items.push({ el, id, next, offset });
  });
  if (options.skip) return out;
  for (const { el, id, next, offset } of items) {
    const prev = before.get(id);
    if (!prev) {
      const enter = typeof options.enter === "function" ? options.enter(el) : options.enter && before.size > 0;
      if (enter) animateEnter(el, options.enterShift ?? -4, Math.max(duration, MOTION.fast));
      continue;
    }
    const dx = prev.left + offset[0] - next.left;
    const dy = prev.top + offset[1] - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (reduced) {
      el.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: MOTION.fast, easing: EASE.out });
      continue;
    }
    el.getAnimations().forEach((anim) => anim.id === "flip" && anim.cancel());
    const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing: EASE.soft });
    anim.id = "flip";
  }
  return out;
}

export function useFlip(container: RefObject<HTMLElement | null>, selector: string, key: string, deps: unknown[], options: FlipOptions = {}) {
  const last = useRef<Rects>(new Map());
  useLayoutEffect(() => {
    last.current = playFlip(container.current, selector, key, last.current, options);
  }, deps);
}

export function useLeaveRef<T extends HTMLElement>(gone: (el: T) => boolean, className = "is-row-leaving", ms: number = MOTION.exit): (el: T | null) => (() => void) | undefined {
  const latest = useRef(gone);
  latest.current = gone;
  const [ref] = useState(() => (el: T | null) => {
    if (!el) return undefined;
    return () => {
      if (latest.current(el)) ghostOut(el, className, ms, { force: true });
    };
  });
  return ref;
}

export function animateHeight(el: HTMLElement, open: boolean, onDone?: () => void) {
  const full = el.scrollHeight;
  const reduced = reducedMotion();
  const frames = open
    ? [{ height: "0px", opacity: 0 }, { height: `${full}px`, opacity: 1 }]
    : [{ height: `${full}px`, opacity: 1 }, { height: "0px", opacity: 0 }];
  el.style.overflow = "hidden";
  const anim = el.animate(reduced ? [{ opacity: frames[0]!.opacity }, { opacity: frames[1]!.opacity }] : frames, { duration: MOTION.base, easing: open ? EASE.out : EASE.in });
  anim.onfinish = () => {
    el.style.overflow = "";
    onDone?.();
  };
  return anim;
}

export function growIn(el: HTMLElement, ms: number = MOTION.slow) {
  const h = el.getBoundingClientRect().height;
  if (reducedMotion()) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.base, easing: EASE.out });
  return el.animate([{ height: "0px", minHeight: "0px", opacity: 0 }, { height: `${h}px`, minHeight: `${h}px`, opacity: 1 }], { duration: ms, easing: EASE.soft });
}

export function shrinkOut(el: HTMLElement, done: () => void, ms: number = MOTION.base) {
  const h = el.getBoundingClientRect().height;
  const frames = reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ height: `${h}px`, minHeight: `${h}px`, opacity: 1 }, { height: "0px", minHeight: "0px", opacity: 0 }];
  const anim = el.animate(frames, { duration: ms, easing: EASE.in, fill: "forwards" });
  anim.onfinish = done;
  return anim;
}

export function useAppearance<T extends HTMLElement>(value: string, ref: RefObject<T | null>): string {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  const grow = useRef(false);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (value) {
      if (!before && !shown) grow.current = true;
      setShown(value);
      return;
    }
    if (before && ref.current) shrinkOut(ref.current, () => setShown(""));
    else setShown("");
  }, [value]);
  useLayoutEffect(() => {
    if (grow.current && shown && ref.current) {
      grow.current = false;
      growIn(ref.current);
    }
  }, [shown]);
  return value || shown;
}

export function useSwapRef<T extends HTMLElement>(options: { prune?: string; ms?: number; className?: string } = {}): (el: T | null) => (() => void) | undefined {
  const leaving = useRef<number | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const [ref] = useState(() => (el: T | null) => {
    if (!el) return undefined;
    const from = leaving.current;
    leaving.current = null;
    if (from !== null && !reducedMotion()) {
      const to = el.getBoundingClientRect().height;
      if (Math.abs(to - from) > 2) el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: latest.current.ms ?? MOTION.base, easing: EASE.out });
    }
    return () => {
      if (!el.isConnected) return;
      leaving.current = el.getBoundingClientRect().height;
      const { prune, ms = MOTION.fast, className = "is-fading" } = latest.current;
      ghostOut(el, className, ms, prune ? { prune } : {});
    };
  });
  return ref;
}

export function useReveal<T extends HTMLElement>(open: boolean, ms: number = MOTION.base): { shown: boolean; ref: RefObject<T | null> } {
  const [shown, setShown] = useState(open);
  const ref = useRef<T>(null);
  const want = useRef(open);
  const first = useRef(true);
  useLayoutEffect(() => {
    want.current = open;
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (open) {
      el?.getAnimations().forEach((a) => a.cancel());
      if (el) el.style.overflow = "";
      if (el && !shown) {
        el.style.overflow = "hidden";
        growIn(el, ms).onfinish = () => {
          el.style.overflow = "";
        };
      }
      setShown(true);
      return;
    }
    if (!el) return setShown(false);
    el.style.overflow = "hidden";
    shrinkOut(el, () => !want.current && setShown(false), Math.min(ms, MOTION.fast + 20));
  }, [open]);
  return { shown: shown || open, ref };
}

export function useHeightTween<T extends HTMLElement>(ref: RefObject<T | null>, key: string, ms: number = MOTION.fast) {
  const lastKey = useRef(key);
  const from = useRef<number | null>(null);
  if (lastKey.current !== key) {
    lastKey.current = key;
    from.current = ref.current?.isConnected ? ref.current.getBoundingClientRect().height : null;
  }
  useLayoutEffect(() => {
    const el = ref.current;
    const start = from.current;
    from.current = null;
    if (!el || start === null || reducedMotion()) return;
    el.getAnimations().forEach((a) => a.id === "height-tween" && a.cancel());
    const end = el.getBoundingClientRect().height;
    if (Math.abs(end - start) < 2) return;
    const anim = el.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: ms, easing: EASE.out });
    anim.id = "height-tween";
  }, [key]);
}

const FADE_IMAGES = ".n-editor img, .n-cover img, .db-card img, .db-gallery-card img, .db-peek img";

export function installImageFades(root: Document | HTMLElement = document): () => void {
  const onLoad = (event: Event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.matches(FADE_IMAGES) || img.closest(".n-ghost")) return;
    if (img.getAnimations().some((a) => a.playState === "running")) return;
    img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.base, easing: EASE.out });
  };
  root.addEventListener("load", onLoad, true);
  return () => root.removeEventListener("load", onLoad, true);
}
