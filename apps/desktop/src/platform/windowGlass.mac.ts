import { ardiaHost, hostSupports, invokeHost, reportHostError } from "../host";
import { WINDOW_BACKDROP_CAPABILITY, type BackdropThemeSource } from "../backdropTheme";
import { animationMovesBackdrop, BACKDROP_METHOD, createMacBackdrops, measureBackdrop, windowBackdropMaterial, type AnimationLike } from "./mac/macGlass.ts";

const MOTION_EVENTS = ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel", "scroll"] as const;

let backdrops: ReturnType<typeof createMacBackdrops> | null = null;

export const behindWindowGlassAvailable = (): boolean => !!ardiaHost && hostSupports(BACKDROP_METHOD);

export const nativeWindowBackdrop = (): boolean => behindWindowGlassAvailable() && hostSupports(WINDOW_BACKDROP_CAPABILITY);

export const refreshBehindWindowGlass = () => backdrops?.refresh();

function blendsAdditively(element: Element) {
  for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
    if (getComputedStyle(node).mixBlendMode === "plus-lighter") return true;
  }
  return false;
}

function ancestorOpacity(element: Element) {
  let opacity = 1;
  for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity) || 0;
  return opacity;
}

function watchMotion(changed: () => void): () => void {
  for (const type of MOTION_EVENTS) document.addEventListener(type, changed, { capture: true, passive: true });
  const mutations = new MutationObserver(changed);
  mutations.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  addEventListener("resize", changed);
  return () => {
    for (const type of MOTION_EVENTS) document.removeEventListener(type, changed, { capture: true });
    mutations.disconnect();
    removeEventListener("resize", changed);
  };
}

const runningAnimations = (layers: readonly Element[], fades: boolean) => animationMovesBackdrop(document.getAnimations() as unknown as readonly AnimationLike[], layers, fades);

export function watchBehindWindowGlass(element: HTMLElement, theme: BackdropThemeSource | null = null): () => void {
  backdrops ??= createMacBackdrops({
    send: (regions) =>
      invokeHost(BACKDROP_METHOD, { regions }).catch((error: unknown) => {
        reportHostError(error);
        throw error;
      }),
    measure: (element) => measureBackdrop(element),
    frame: (run) => requestAnimationFrame(run),
    timeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    watch: (target, changed) => {
      const observer = new ResizeObserver(changed);
      observer.observe(target);
      return () => observer.disconnect();
    },
    watchMotion,
    animating: runningAnimations,
    opacity: ancestorOpacity,
    additive: blendsAdditively,
  });
  return backdrops.add(element, windowBackdropMaterial((method) => hostSupports(method)), theme);
}
