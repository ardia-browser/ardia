import { Animated as LinuxAnimated } from "../reactNative/index";
import { notePageMotion, type PageMotion } from "./pageMotion";
import { animatePageHoles, stopPageHoles } from "./pageSlots";

type Easing = (t: number) => number;
type Curve = { durationMs: number; at: (ms: number) => number };
type AnimatedNode = { __getChildren?: () => AnimatedNode[] };
type ValueNode = { __getChildren?: () => AnimatedNode[]; _value: number; _offset: number; _animation?: { stop(): void } | null; __getValue(): number; setValue(value: number): void; stopAnimation?(): void };
type PropsNode = { _animatedView?: unknown; __getValue(): { style?: unknown } };
type Config = Record<string, unknown> & { toValue?: unknown; useNativeDriver?: boolean; delay?: number };
type CompositeAnimation = { start(callback?: (result: { finished: boolean }) => void): void; stop(): void; reset?(): void };
type Box = { x: number; y: number; width: number; height: number };
type Mirror = { animations: globalThis.Animation[]; pages: string[] };

const SAMPLE_MS = 1000 / 120;
const LONGEST_MS = 4000;
const DEFAULT_TIMING_MS = 500;

let mirrored = 0;
let lastMirror: unknown = null;
let skipped = 0;

const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function springCurve(config: Config, from: number, to: number): Curve | null {
  const stiffness = number(config.stiffness, 0);
  const damping = number(config.damping, 0);
  const mass = number(config.mass, 1);
  if (!(stiffness > 0) || !(damping > 0) || !(mass > 0)) return null;
  const clamp = config.overshootClamping === true;
  const restDisplacement = number(config.restDisplacementThreshold, 0.001);
  const restSpeed = number(config.restSpeedThreshold, 0.001);
  const v0 = -number(config.velocity, 0);
  const x0 = to - from;
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const omega0 = Math.sqrt(stiffness / mass);
  const omega1 = omega0 * Math.sqrt(Math.abs(1 - zeta * zeta));
  const position = (seconds: number) => {
    if (zeta < 1) {
      const envelope = Math.exp(-zeta * omega0 * seconds);
      return to - envelope * (((v0 + zeta * omega0 * x0) / omega1) * Math.sin(omega1 * seconds) + x0 * Math.cos(omega1 * seconds));
    }
    const envelope = Math.exp(-omega0 * seconds);
    return to - envelope * (x0 + (v0 + omega0 * x0) * seconds);
  };
  let end = LONGEST_MS;
  for (let ms = SAMPLE_MS; ms <= LONGEST_MS; ms += SAMPLE_MS) {
    const now = position(ms / 1000);
    const speed = Math.abs(now - position((ms - 1) / 1000)) * 1000;
    const overshot = clamp && (from < to ? now > to : now < to);
    if (overshot || (speed <= restSpeed && Math.abs(to - now) <= restDisplacement)) {
      end = ms;
      break;
    }
  }
  return {
    durationMs: end,
    at: (ms) => {
      if (ms >= end) return to;
      const now = position(ms / 1000);
      if (!clamp) return now;
      return from < to ? Math.min(now, to) : Math.max(now, to);
    },
  };
}

function timingCurve(config: Config, from: number, to: number): Curve {
  const durationMs = number(config.duration, DEFAULT_TIMING_MS);
  const easing = typeof config.easing === "function" ? (config.easing as Easing) : (t: number) => t;
  return {
    durationMs,
    at: (ms) => (durationMs <= 0 || ms >= durationMs ? to : from + (to - from) * easing(ms / durationMs)),
  };
}

function boundViews(value: AnimatedNode): PropsNode[] {
  const found = new Set<PropsNode>();
  const seen = new Set<AnimatedNode>();
  const walk = (node: AnimatedNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    if ("_animatedView" in node && (node as PropsNode)._animatedView instanceof Element) found.add(node as unknown as PropsNode);
    for (const child of node.__getChildren?.() ?? []) walk(child);
  };
  walk(value as AnimatedNode);
  return [...found];
}

function cssTransform(transform: unknown): string | null {
  if (!Array.isArray(transform)) return null;
  const parts: string[] = [];
  for (const step of transform) {
    if (!step || typeof step !== "object") continue;
    for (const [name, raw] of Object.entries(step as Record<string, unknown>)) {
      const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
      if (name === "translateX" || name === "translateY") parts.push(`${name}(${value}px)`);
      else if (name === "scale" || name === "scaleX" || name === "scaleY") parts.push(`${name}(${value})`);
      else if (name === "rotate" || name === "rotateZ") parts.push(`rotate(${typeof raw === "number" ? `${raw}deg` : raw})`);
      else return null;
    }
  }
  return parts.join(" ") || "none";
}

function styleOf(props: PropsNode) {
  const raw = props.__getValue().style;
  const style = (Array.isArray(raw) ? Object.assign({}, ...raw.flat(Infinity)) : (raw ?? {})) as Record<string, unknown>;
  const transform = "transform" in style ? cssTransform(style.transform) : null;
  const opacity = typeof style.opacity === "number" ? style.opacity : null;
  const { transform: _transform, opacity: _opacity, ...others } = style;
  const unsupported = ("transform" in style && transform === null) || JSON.stringify(others);
  return { transform, opacity, unsupported };
}

function withValueAt<Result>(value: ValueNode, raw: number, read: () => Result): Result {
  const kept = value._value;
  value._value = raw - value._offset;
  try {
    return read();
  } finally {
    value._value = kept;
  }
}

const affine = (transform: string | null) => new DOMMatrix(transform && transform !== "none" ? transform : undefined);

function pageBoxesUnder(element: Element): { key: string; box: Box; view: Element }[] {
  return [...element.querySelectorAll<HTMLElement>("[data-ardia-page-slot]")].flatMap((marker) => {
    const page = marker.nextElementSibling;
    const key = marker.dataset.ardiaPageSlot;
    if (!key || !page) return [];
    const rect = page.getBoundingClientRect();
    return [{ key, view: page, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
  });
}

function movedBox(box: Box, center: { x: number; y: number }, now: DOMMatrix, then: DOMMatrix): Box {
  const sx = now.a || 1;
  const sy = now.d || 1;
  const local = { x: center.x + (box.x - now.e - center.x) / sx, y: center.y + (box.y - now.f - center.y) / sy, width: box.width / sx, height: box.height / sy };
  return {
    x: Math.round((center.x + (local.x - center.x) * then.a + then.e) * 10) / 10,
    y: Math.round((center.y + (local.y - center.y) * then.d + then.f) * 10) / 10,
    width: Math.round(local.width * then.a * 10) / 10,
    height: Math.round(local.height * then.d * 10) / 10,
  };
}

function untransformedCenter(element: Element, now: DOMMatrix) {
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width / 2 - now.e, y: rect.y + rect.height / 2 - now.f };
}

function startMirror(value: ValueNode, curve: Curve): Mirror | null {
  const views = boundViews(value);
  if (!views.length) return null;
  const steps = Math.max(2, Math.ceil(curve.durationMs / SAMPLE_MS) + 1);
  const times = Array.from({ length: steps }, (_, index) => Math.min(curve.durationMs, index * SAMPLE_MS));
  const animations: globalThis.Animation[] = [];
  const pages: string[] = [];
  const sampled = views.map((props) => ({ props, frames: times.map((ms) => withValueAt(value, curve.at(ms), () => styleOf(props))) }));
  if (sampled.some(({ frames }) => frames.some((frame) => frame.unsupported !== frames[0]?.unsupported || frame.unsupported === true))) return null;
  for (const { props, frames } of sampled) {
    const element = props._animatedView as HTMLElement;
    const moves = frames.some((frame) => frame.transform !== frames[0]?.transform);
    const fades = frames.some((frame) => frame.opacity !== frames[0]?.opacity);
    if (!moves && !fades) continue;
    const keyframes = frames.map((frame, index) => {
      const keyframe: Keyframe = { offset: curve.durationMs > 0 ? (times[index] ?? 0) / curve.durationMs : 1 };
      if (moves) keyframe.transform = frame.transform ?? "none";
      if (fades) keyframe.opacity = String(frame.opacity ?? 1);
      return keyframe;
    });
    const played = element.animate(keyframes, { duration: curve.durationMs, easing: "linear", fill: "forwards" });
    animations.push(played);
    if (!moves) continue;
    const start = affine(frames[0]?.transform ?? null);
    const center = untransformedCenter(element, start);
    for (const { key, box, view } of pageBoxesUnder(element)) {
      const rects = frames.map((frame) => movedBox(box, center, start, affine(frame.transform)));
      lastMirror = { key, box, center, start: [start.a, start.d, start.e, start.f], origin: getComputedStyle(element).transformOrigin, transforms: [frames[0]?.transform, frames[Math.floor(frames.length / 2)]?.transform, frames[frames.length - 1]?.transform], rects: [rects[0], rects[Math.floor(rects.length / 2)], rects[rects.length - 1]], element: [element.offsetWidth, element.offsetHeight] };
      const motion: PageMotion = { durationMs: Math.round(curve.durationMs), rects: rects.map((rect) => [rect.x, rect.y, rect.width, rect.height]) };
      if (!notePageMotion(key, motion)) continue;
      pages.push(key);
      animatePageHoles(key, view, element, () => Number(played.currentTime ?? 0), motion.durationMs, motion.rects);
    }
  }
  if (!animations.length) return null;
  mirrored += 1;
  return { animations, pages };
}

function stopMirror(mirror: Mirror | null, finished: boolean) {
  if (!mirror) return;
  for (const animation of mirror.animations) animation.cancel();
  for (const key of mirror.pages) stopPageHoles(key);
  if (!finished) for (const key of mirror.pages) notePageMotion(key, null);
}

function mirroredAnimation(kind: "spring" | "timing", value: ValueNode, config: Config, animation: CompositeAnimation): CompositeAnimation {
  let mirror: Mirror | null = null;
  let onCompositor = false;
  let settled = false;
  let startedAt = 0;
  let curve: Curve | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: ((result: { finished: boolean }) => void) | undefined;
  const handle = { stop: () => settle(false, curve ? curve.at(performance.now() - startedAt) : value.__getValue()) };
  function settle(finished: boolean, at: number) {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    if (value._animation === handle) value._animation = null;
    const ending = mirror;
    mirror = null;
    value.setValue(at);
    requestAnimationFrame(() => requestAnimationFrame(() => stopMirror(ending, finished)));
    done?.({ finished });
  }
  return {
    ...animation,
    start(callback) {
      value.stopAnimation?.();
      const from = value.__getValue();
      const to = typeof config.toValue === "number" ? config.toValue : null;
      curve = to === null || number(config.delay, 0) > 0 ? null : kind === "spring" ? springCurve(config, from, to) : timingCurve(config, from, to);
      try {
        mirror = curve ? startMirror(value, curve) : null;
      } catch (error) {
        console.error("[ardia linux] the compositor copy of an animation failed", error);
        mirror = null;
      }
      if (!mirror || !curve || to === null) {
        skipped += 1;
        animation.start(callback);
        return;
      }
      onCompositor = true;
      done = callback;
      startedAt = performance.now();
      value._animation = handle;
      timer = setTimeout(() => settle(true, to), curve.durationMs);
    },
    stop() {
      if (onCompositor) handle.stop();
      else animation.stop();
    },
  };
}

const wantsNative = (config: Config | undefined) => config?.useNativeDriver === true;

export const Animated = {
  ...LinuxAnimated,
  spring: (value: never, config: Config) => {
    const animation = LinuxAnimated.spring(value, config as never) as unknown as CompositeAnimation;
    return wantsNative(config) ? mirroredAnimation("spring", value as unknown as ValueNode, config, animation) : animation;
  },
  timing: (value: never, config: Config) => {
    const animation = LinuxAnimated.timing(value, config as never) as unknown as CompositeAnimation;
    return wantsNative(config) ? mirroredAnimation("timing", value as unknown as ValueNode, config, animation) : animation;
  },
} as unknown as typeof LinuxAnimated;

export const compositorAnimationState = () => ({ mirrored, skipped, lastMirror });

Object.assign(globalThis, { ardiaCompositorAnimation: compositorAnimationState });
