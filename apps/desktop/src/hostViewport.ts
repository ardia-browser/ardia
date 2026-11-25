import type { TabViewport } from "./hostTab";
import { PAGE_STACK_ATTRIBUTE } from "./pageHoles.ts";

export type { TabViewport };

type Bounds = TabViewport["rect"];

const EXTENSION_POPUP_DISMISS = '[data-testid="ardia-extension-popup-dismiss"]';
export const STACKED_PAGE = `[${PAGE_STACK_ATTRIBUTE}] [data-ardia-native-tab]`;
const MOTION_EVENTS = ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"] as const;
const CLIPS_OVERFLOW = new Set(["hidden", "clip", "scroll", "auto"]);
const CONTENT_RECT_EPSILON = 0.01;

const boxOf = (element: Element): Bounds => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

const borderWidth = (value: string | undefined) => {
  const px = Number.parseFloat(value ?? "");
  return Number.isFinite(px) && px > 0 ? px : 0;
};

function clipBoxOf(element: Element, raw: Bounds): Bounds {
  let left = raw.x;
  let top = raw.y;
  let right = raw.x + raw.width;
  let bottom = raw.y + raw.height;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = CLIPS_OVERFLOW.has(style.overflowX);
    const clipsY = CLIPS_OVERFLOW.has(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const outer = parent.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, outer.left + borderWidth(style.borderLeftWidth));
      right = Math.min(right, outer.right - borderWidth(style.borderRightWidth));
    }
    if (clipsY) {
      top = Math.max(top, outer.top + borderWidth(style.borderTopWidth));
      bottom = Math.min(bottom, outer.bottom - borderWidth(style.borderBottomWidth));
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function clippedRectOf(element: Element): Bounds {
  return clipBoxOf(element, boxOf(element));
}

const sameRect = (a: Bounds, b: Bounds) =>
  Math.abs(a.x - b.x) <= CONTENT_RECT_EPSILON &&
  Math.abs(a.y - b.y) <= CONTENT_RECT_EPSILON &&
  Math.abs(a.width - b.width) <= CONTENT_RECT_EPSILON &&
  Math.abs(a.height - b.height) <= CONTENT_RECT_EPSILON;

const viewportWatchers = new Set<() => void>();
export const refreshTabViewports = () => {
  for (const watcher of viewportWatchers) watcher();
};

export function tabViewport(rect: Bounds, viewport: { width: number; height: number }, visible: boolean): TabViewport {
  const finite = [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  const intersects = finite && rect.width > 0 && rect.height > 0 && rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  return { rect: finite ? { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) } : { x: 0, y: 0, width: 0, height: 0 }, visible: visible && intersects };
}

function plainViewport(element: HTMLElement, rect: Bounds, viewport: TabViewport, cover: OverlayCover): { viewport: TabViewport; covered: boolean } {
  if (!viewport.visible) return { viewport, covered: false };
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return { viewport: { ...viewport, visible: false }, covered: false };
  }
  const rectLeft = rect.x;
  const rectTop = rect.y;
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;
  const insetX = Math.min(16, rect.width / 4);
  const insetY = Math.min(16, rect.height / 4);
  const left = Math.max(0, rectLeft) + insetX;
  const top = Math.max(0, rectTop) + insetY;
  const right = Math.min(window.innerWidth, rectRight) - insetX;
  const bottom = Math.min(window.innerHeight, rectBottom) - insetY;
  const dismiss = document.querySelector<HTMLElement>(EXTENSION_POPUP_DISMISS);
  const points = [[left, top], [right, top], [left, bottom], [right, bottom], [(left + right) / 2, (top + bottom) / 2]] as const;
  const seen = points.map(([x, y]): "shown" | "page" | "covered" | "missed" => {
    if (cover.overlayAt(x, y)) return "shown";
    const hit = document.elementFromPoint(x, y);
    if (!hit) return "missed";
    if (hit === element || element.contains(hit) || !!dismiss?.contains(hit)) return "shown";
    return hit.closest?.(STACKED_PAGE) ? "page" : "covered";
  });
  const coveredInPage = points.some(([x, y], index) => seen[index] === "covered" && x >= rectLeft && x < rectRight && y >= rectTop && y < rectBottom);
  return seen.includes("shown") && !seen.includes("covered") && !seen.includes("missed") ? { viewport, covered: false } : { viewport: { ...viewport, visible: false }, covered: coveredInPage };
}

type OverlayCover = { overlayAt: (x: number, y: number) => boolean; overlayElements: () => readonly Element[] };

export function watchTabViewport(element: HTMLElement, visible: () => boolean, report: (viewport: TabViewport, covered: boolean) => void, cover: OverlayCover, clipToAncestors = true) {
  let frame = 0;
  let stopped = false;
  const measure = () => {
    if (stopped) return;
    const raw = boxOf(element);
    const rect = clipToAncestors ? clipBoxOf(element, raw) : raw;
    const viewport = tabViewport(rect, { width: window.innerWidth, height: window.innerHeight }, visible() && !document.hidden && element.isConnected);
    const plain = plainViewport(element, rect, viewport, cover);
    const reported = plain.viewport.visible && [raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) && raw.width > 0 && raw.height > 0 && !sameRect(raw, plain.viewport.rect)
      ? { ...plain.viewport, contentRect: raw }
      : plain.viewport;
    report(reported, plain.covered);
    if (animating()) measureNextFrame();
  };
  const animating = () => !!document.getAnimations?.().some((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (animation.playState !== "running" || !target) return false;
    return target.contains(element) || cover.overlayElements().some((overlay) => overlay.contains(target));
  });
  const measureNextFrame = () => {
    if (frame || stopped) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };
  const mutations = new MutationObserver(measureNextFrame);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const resizes = new ResizeObserver(measure);
  resizes.observe(element);
  viewportWatchers.add(measureNextFrame);
  window.addEventListener("resize", measure);
  window.addEventListener("scroll", measure, true);
  document.addEventListener("visibilitychange", measure);
  for (const type of MOTION_EVENTS) document.addEventListener(type, measureNextFrame, true);
  window.visualViewport?.addEventListener("resize", measure);
  window.visualViewport?.addEventListener("scroll", measure);
  measure();
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resizes.disconnect();
    viewportWatchers.delete(measureNextFrame);
    window.removeEventListener("resize", measure);
    window.removeEventListener("scroll", measure, true);
    document.removeEventListener("visibilitychange", measure);
    for (const type of MOTION_EVENTS) document.removeEventListener(type, measureNextFrame, true);
    window.visualViewport?.removeEventListener("resize", measure);
    window.visualViewport?.removeEventListener("scroll", measure);
  };
}
