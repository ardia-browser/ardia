import type { BackdropTheme, BackdropThemeSource } from "../../backdropTheme.ts";

export const BACKDROP_METHOD = "shell.backdropRegions";
export const BACKDROP_MATERIALS = ["liquid", "sidebar", "underWindow", "windowTreatment"] as const;
export const WINDOW_TREATMENT_CAPABILITY = "shell.backdropRegions.windowTreatment";
export const BACKDROP_RETRY_MS = 250;
export const BACKDROP_RETRY_MAX_MS = 4000;
export type BackdropMaterial = (typeof BACKDROP_MATERIALS)[number];
export type BackdropRect = { x: number; y: number; width: number; height: number };
export type BackdropRegion = { rect: BackdropRect; material: BackdropMaterial; theme?: BackdropTheme };

type BackdropDeps = {
  send: (regions: BackdropRegion[]) => Promise<unknown>;
  measure: (element: Element) => BackdropRect | null;
  frame: (run: () => void) => void;
  timeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  watch: (element: Element, changed: () => void) => () => void;
  watchMotion: (changed: () => void) => () => void;
  animating: (layers: readonly Element[], fades: boolean) => boolean;
  opacity?: (element: Element) => number;
  additive?: (element: Element) => boolean;
};

export type MeasuredBackdrop = { region: BackdropRegion; additive: boolean };

export function settleBackdrops(measured: readonly MeasuredBackdrop[]): BackdropRegion[] {
  const kept: MeasuredBackdrop[] = [];
  const byKey = new Map<string, number>();
  for (const entry of measured) {
    const { region } = entry;
    if (region.theme && !(region.theme.opacity > 0)) continue;
    const key = JSON.stringify(region.theme ? { ...region, theme: { ...region.theme, opacity: 0 } } : region);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, kept.length);
      kept.push(entry);
      continue;
    }
    const earlier = kept[at]!;
    if (!region.theme || !earlier.region.theme) continue;
    kept[at] = {
      region: { ...earlier.region, theme: { ...earlier.region.theme, opacity: +Math.min(1, earlier.region.theme.opacity + region.theme.opacity).toFixed(4) } },
      additive: earlier.additive || entry.additive,
    };
  }
  return settleCrossFades(kept.map((entry) => entry.region), kept.map((entry) => entry.additive));
}

export function settleCrossFades(regions: BackdropRegion[], additive: readonly boolean[]): BackdropRegion[] {
  const stacks = new Map<string, number[]>();
  regions.forEach((region, index) => {
    if (!region.theme) return;
    const key = JSON.stringify(region.rect);
    stacks.set(key, [...(stacks.get(key) ?? []), index]);
  });
  const settled = [...regions];
  for (const members of stacks.values()) {
    if (members.length < 2 || !members.some((index) => additive[index])) continue;
    const bottom = members[0]!;
    const total = members.reduce((sum, index) => sum + (regions[index]!.theme?.opacity ?? 0), 0);
    settled[bottom] = { ...regions[bottom]!, theme: { ...regions[bottom]!.theme!, opacity: +Math.min(1, total).toFixed(4) } };
  }
  return settled;
}

export type AnimationLike = { playState: string; effect: { target?: Element | null; getKeyframes?: () => readonly Record<string, unknown>[] } | null };

const TIMING_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);

export const fadesOnly = (animation: AnimationLike): boolean => {
  const frames = animation.effect?.getKeyframes?.();
  return !!frames && frames.every((frame) => Object.keys(frame).every((key) => key === "opacity" || TIMING_KEYS.has(key)));
};

export const animationMovesBackdrop = (animations: readonly AnimationLike[], layers: readonly Element[], fades = false): boolean =>
  animations.some((animation) => {
    const target = animation.playState === "running" ? animation.effect?.target : null;
    return !!target && (fades || !fadesOnly(animation)) && layers.some((layer) => target === layer || target.contains(layer));
  });

const HIDDEN_VISIBILITY = new Set(["hidden", "collapse"]);

export function measureBackdrop(element: Element, style: (element: Element) => { visibility: string } | null = (target) => (typeof getComputedStyle === "function" ? getComputedStyle(target) : null)): BackdropRect | null {
  if (!element.isConnected) return null;
  if (HIDDEN_VISIBILITY.has(style(element)?.visibility ?? "")) return null;
  const r = element.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export const windowBackdropMaterial = (supports: (method: string) => boolean): BackdropMaterial => (supports(WINDOW_TREATMENT_CAPABILITY) ? "windowTreatment" : "liquid");

export function createMacBackdrops(deps: BackdropDeps) {
  const layers = new Map<Element, { material: BackdropMaterial; theme: BackdropThemeSource | null; stop: () => void }>();
  let frameQueued = false;
  let accepted = "[]";
  let inFlight = false;
  let resendAfterReply = false;
  let failures = 0;
  let retry: unknown = null;
  let stopMotion: (() => void) | null = null;

  const measured = () => {
    const regions = settleBackdrops([...layers].flatMap(([element, { material, theme }]): MeasuredBackdrop[] => {
      const rect = deps.measure(element);
      if (!rect) return [];
      const painted = theme?.(rect) ?? null;
      const opacity = painted && deps.opacity ? Math.min(1, Math.max(0, deps.opacity(element))) : 1;
      const region: BackdropRegion = painted ? { rect, material, theme: { ...painted, opacity: +(painted.opacity * opacity).toFixed(4) } } : { rect, material };
      return [{ region, additive: !!painted && !!deps.additive?.(element) }];
    }));
    return { regions, text: JSON.stringify(regions) };
  };

  const transmit = () => {
    if (retry !== null) return;
    if (inFlight) {
      resendAfterReply = true;
      return;
    }
    const { regions, text } = measured();
    if (text === accepted) return;
    inFlight = true;
    deps.send(regions).then(
      () => {
        accepted = text;
        failures = 0;
      },
      () => {
        failures += 1;
        if (retry === null) {
          retry = deps.timeout(() => {
            retry = null;
            schedule();
          }, Math.min(BACKDROP_RETRY_MS * 2 ** (failures - 1), BACKDROP_RETRY_MAX_MS));
        }
      },
    ).finally(() => {
      inFlight = false;
      if (!resendAfterReply) return;
      resendAfterReply = false;
      schedule();
    });
  };

  const flush = () => {
    frameQueued = false;
    transmit();
    if (layers.size && deps.animating([...layers.keys()], [...layers.values()].some((entry) => entry.theme))) schedule();
  };

  function schedule() {
    if (frameQueued) return;
    frameQueued = true;
    deps.frame(flush);
  }

  return {
    add(element: Element, material: BackdropMaterial = "liquid", theme: BackdropThemeSource | null = null) {
      const entry = { material, theme, stop: deps.watch(element, schedule) };
      layers.set(element, entry);
      stopMotion ??= deps.watchMotion(schedule);
      schedule();
      return () => {
        if (layers.get(element) !== entry) return;
        entry.stop();
        layers.delete(element);
        if (!layers.size && stopMotion) {
          stopMotion();
          stopMotion = null;
        }
        schedule();
      };
    },
    setMaterial(material: BackdropMaterial) {
      for (const entry of layers.values()) entry.material = material;
      schedule();
    },
    dispose() {
      if (retry !== null) deps.clearTimeout(retry);
      retry = null;
    },
    refresh: schedule,
    flushNow: flush,
    size: () => layers.size,
  };
}
