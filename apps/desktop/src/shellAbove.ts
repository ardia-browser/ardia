import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import { hostSupports, INPUT_REGIONS_METHOD, invokeHost, reportHostError, type ArdiaHost } from "./host.ts";
import { createInputRegions, type InputRegionsRegistry, type RegionDeps, type RegionShape } from "./inputRegions.ts";
import { clippedRectOf } from "./hostViewport.ts";
import { createPageHoles, type PageHoles } from "./pageHoles.ts";
import { PEEK_MOVING_ATTRIBUTE } from "./peekStageMotion.ts";
import { startShellGlass } from "./shellGlass.ts";
import { GLASS_BEHIND_WINDOW } from "./glassRegions.ts";
import { currentWindowCorners, onWindowCornersChanged } from "./windowDecorations.ts";

const SHELL_ABOVE_CLASS = "ardia-shell-above";
const MOVING_STAGE = `[${PEEK_MOVING_ATTRIBUTE}]`;
const MOTION_EVENTS = ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"] as const;

let regions: InputRegionsRegistry | null = null;
let holes: PageHoles | null = null;
export const inputRegions = () => regions;
export const pageHoles = () => holes;
export const shellOverPages = () => regions !== null;

const concealed = new WeakMap<HTMLElement, string>();

export function domRegionDeps(host: ArdiaHost): Omit<RegionDeps, "conceal"> {
  return {
    send: hostSupports(INPUT_REGIONS_METHOD, host) ? (next) => invokeHost<void>(INPUT_REGIONS_METHOD, next, host) : null,
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    rectOf: (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    },
    pageRectOf: clippedRectOf,
    receivesPointer: (element) => getComputedStyle(element).pointerEvents !== "none",
    watch: (element, changed) => {
      const mutations = new MutationObserver(changed);
      mutations.observe(element, { subtree: true, childList: true, attributes: true });
      for (let parent = element.parentElement; parent; parent = parent.parentElement) mutations.observe(parent, { attributes: true, attributeFilter: ["style", "class"] });
      for (const type of MOTION_EVENTS) element.addEventListener(type, changed);
      return () => {
        mutations.disconnect();
        for (const type of MOTION_EVENTS) element.removeEventListener(type, changed);
      };
    },
    animating: (elements) => !!document.getAnimations?.().some((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return animation.playState === "running" && !!target && elements.some((element) => element.contains(target) || target.contains(element));
    }),
    microtask: (run) => queueMicrotask(run),
    frame: (run) => void requestAnimationFrame(run),
    frameTime: () => Number(document.timeline.currentTime ?? performance.now()),
    timeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    report: reportHostError,
  };
}

function conceal(element: Element, hidden: boolean) {
  const node = element as HTMLElement;
  if (hidden && node.contains(document.activeElement)) return;
  if (hidden) {
    if (!concealed.has(node)) concealed.set(node, node.style.visibility);
    node.style.visibility = "hidden";
  } else if (concealed.has(node)) {
    node.style.visibility = concealed.get(node)!;
    concealed.delete(node);
  }
}

export function startShellAbove(host: ArdiaHost, root: HTMLElement = document.body) {
  document.documentElement.classList.add(SHELL_ABOVE_CLASS);
  const inMovingStage = (element: Element) => !!element.closest?.(MOVING_STAGE);
  const painter = createPageHoles(root, () => host.bootstrap.shellZoom ?? 1, currentWindowCorners, inMovingStage);
  const stopCorners = onWindowCornersChanged(() => painter.windowChanged());
  const glass = startShellGlass(host, (next) => painter.glassChanged(next));
  const registry = createInputRegions({
    ...domRegionDeps(host),
    pageFrozen: inMovingStage,
    conceal,
    pagesChanged: (areas) => {
      painter.pagesChanged(areas);
      glass.glass.setPages(areas.map((area) => area.rect));
    },
  });
  holes = painter;
  regions = registry;
  const refresh = () => registry.refresh();
  const resized = () => {
    registry.refresh();
    painter.windowChanged();
  };
  const stagesMoving = new MutationObserver(resized);
  stagesMoving.observe(root, { subtree: true, attributes: true, attributeFilter: [PEEK_MOVING_ATTRIBUTE] });
  window.addEventListener("resize", resized);
  window.addEventListener("scroll", refresh, true);
  return () => {
    stagesMoving.disconnect();
    window.removeEventListener("resize", resized);
    window.removeEventListener("scroll", refresh, true);
    document.documentElement.classList.remove(SHELL_ABOVE_CLASS);
    glass.stop();
    stopCorners();
    if (regions === registry) regions = null;
    if (holes === painter) holes = null;
  };
}

const UTILITY_GLASS_CLASS = "ardia-utility-glass";

export function startUtilityShellGlass(host: ArdiaHost, root: HTMLElement = document.body) {
  const transparent = hostSupports(GLASS_BEHIND_WINDOW, host);
  if (transparent) document.documentElement.classList.add(UTILITY_GLASS_CLASS);
  const painter = createPageHoles(root, () => host.bootstrap.shellZoom ?? 1, currentWindowCorners);
  const stopCorners = onWindowCornersChanged(() => painter.windowChanged());
  const glass = startShellGlass(host, (next) => painter.glassChanged(next));
  holes = painter;
  const resized = () => {
    glass.glass.refresh();
    painter.windowChanged();
  };
  window.addEventListener("resize", resized);
  return () => {
    window.removeEventListener("resize", resized);
    document.documentElement.classList.remove(UTILITY_GLASS_CLASS);
    glass.stop();
    stopCorners();
    if (holes === painter) holes = null;
  };
}

export function useInputRegion(ref: RefObject<Element | null>, shape: RegionShape = "box", gated = true, capturing = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    return capturing && element && regions ? regions.addOverlay(element, shape, gated) : undefined;
  }, [shape, gated, capturing]);
}

export const AbovePages = createContext(false);
export const NativeBackdropRoot = createContext(false);
export const useNativeBackdropRoot = () => useContext(NativeBackdropRoot);

export function usePageHoleLayer(ref: RefObject<HTMLElement | null>) {
  const abovePages = useContext(AbovePages);
  useLayoutEffect(() => {
    const element = ref.current;
    return element && holes && !abovePages ? holes.addLayer(element) : undefined;
  }, [abovePages]);
}
