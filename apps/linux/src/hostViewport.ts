import type { TabViewport } from "./hostTab";
import { PAGE_STACK_ATTRIBUTE } from "./pageHoles.ts";
import { noteSlideFrameKept } from "../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/consentPeriod.ts";

export type { TabViewport };

type Bounds = TabViewport["rect"];

const EXTENSION_POPUP_DISMISS = '[data-testid="ardia-extension-popup-dismiss"]';
export const STACKED_PAGE = `[${PAGE_STACK_ATTRIBUTE}] [data-ardia-native-tab]`;
const MOTION_EVENTS = ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"] as const;

export const TOOLBAR_SLIDE = '[data-testid="ardia.toolbarSlide"]';

const viewportWatchers = new Set<() => void>();
export const refreshTabViewports = () => {
  for (const watcher of viewportWatchers) watcher();
};

export function tabViewport(rect: Bounds, viewport: { width: number; height: number }, visible: boolean): TabViewport {
  const finite = [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  const intersects = finite && rect.width > 0 && rect.height > 0 && rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  return { rect: finite ? { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) } : { x: 0, y: 0, width: 0, height: 0 }, visible: visible && intersects };
}

function slideOf(transform: string) {
  const matrix = /^matrix(3d)?\((.*)\)$/.exec(transform);
  if (!matrix) return { x: 0, y: 0 };
  const values = (matrix[2] ?? "").split(",").map(Number);
  const x = values[matrix[1] ? 12 : 4] ?? Number.NaN;
  const y = values[matrix[1] ? 13 : 5] ?? Number.NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { x: 0, y: 0 };
}

export function heldInPane(element: HTMLElement, rect: DOMRectReadOnly, consent?: ConsentToken | null): DOMRectReadOnly {
  const group = element.closest?.(TOOLBAR_SLIDE);
  const pane = group?.parentElement?.getBoundingClientRect();
  if (!group || !pane) return rect;
  const slide = slideOf(getComputedStyle(group).transform);
  const left = Math.max(rect.left - slide.x, pane.left);
  const top = Math.max(rect.top - slide.y, pane.top);
  const right = Math.max(Math.min(rect.right - slide.x, pane.right), left);
  const bottom = Math.max(Math.min(rect.bottom - slide.y, pane.bottom), top);
  if (rect.left < pane.left || rect.top < pane.top || rect.right > pane.right || rect.bottom > pane.bottom) noteSlideFrameKept(consent);
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) };
}

function plainViewport(element: HTMLElement, rect: DOMRectReadOnly, viewport: TabViewport, cover: OverlayCover): { viewport: TabViewport; covered: boolean } {
  if (!viewport.visible) return { viewport, covered: false };
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return { viewport: { ...viewport, visible: false }, covered: false };
  }
  const insetX = Math.min(16, rect.width / 4);
  const insetY = Math.min(16, rect.height / 4);
  const left = Math.max(0, rect.left) + insetX;
  const top = Math.max(0, rect.top) + insetY;
  const right = Math.min(window.innerWidth, rect.right) - insetX;
  const bottom = Math.min(window.innerHeight, rect.bottom) - insetY;
  const dismiss = document.querySelector<HTMLElement>(EXTENSION_POPUP_DISMISS);
  const points = [[left, top], [right, top], [left, bottom], [right, bottom], [(left + right) / 2, (top + bottom) / 2]] as const;
  const seen = points.map(([x, y]): "shown" | "page" | "covered" | "missed" => {
    if (cover.overlayAt(x, y)) return "shown";
    const hit = document.elementFromPoint(x, y);
    if (!hit) return "missed";
    if (hit === element || element.contains(hit) || !!dismiss?.contains(hit)) return "shown";
    return hit.closest?.(STACKED_PAGE) ? "page" : "covered";
  });
  const coveredInPage = points.some(([x, y], index) => seen[index] === "covered" && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
  return seen.includes("shown") && !seen.includes("covered") && !seen.includes("missed") ? { viewport, covered: false } : { viewport: { ...viewport, visible: false }, covered: coveredInPage };
}

export type OverlayCover = { overlayAt: (x: number, y: number) => boolean; overlayElements: () => readonly Element[] };

export function watchTabViewport(element: HTMLElement, visible: () => boolean, report: (viewport: TabViewport, covered: boolean) => void, cover: OverlayCover) {
  const consent = consentToken();
  let frame = 0;
  let stopped = false;
  const measure = () => {
    if (stopped) return;
    const rect = heldInPane(element, element.getBoundingClientRect(), consent);
    const viewport = tabViewport(rect, { width: window.innerWidth, height: window.innerHeight }, visible() && !document.hidden && element.isConnected);
    const plain = plainViewport(element, rect, viewport, cover);
    report(plain.viewport, plain.covered);
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
