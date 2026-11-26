export type StageRect = { x: number; y: number; width: number; height: number };
export type StageGeometry = { width: number; height: number; card: StageRect; source: StageRect; fullscreen: boolean };
export type StageMove = "enter" | "close" | "promote";
export type StagePhase = "waiting" | "entering" | "open" | "closing" | "promoting" | "finished";
export type StageOutcome = "closed" | "promoted";
export type StageEntrance = "affine" | "fade";
export type StageFrame = { transform?: string; opacity?: number; offset?: number };
export type StageMotion = { card: StageFrame[]; scrim: StageFrame[]; duration: number; easing: string };

export const COMPOSITOR_PROPERTIES = new Set(["transform", "opacity", "clipPath", "offset"]);
export const PEEK_MOVING_ATTRIBUTE = "data-ardia-peek-moving";
export const START_SCALE = 0.12;
export const ENTER_MS = 200;
export const STEP_MS = 150;
const ENTER_EASING = "cubic-bezier(0.2, 0.9, 0.3, 1)";
const CLOSE_EASING = "cubic-bezier(0.55, 0.085, 0.68, 0.53)";
const PROMOTE_EASING = "cubic-bezier(0.215, 0.61, 0.355, 1)";
const IDENTITY = "translate(0px, 0px) scale(1, 1)";

const fixed = (n: number) => +n.toFixed(4);
const affine = (dx: number, dy: number, sx: number, sy: number) => `translate(${fixed(dx)}px, ${fixed(dy)}px) scale(${fixed(sx)}, ${fixed(sy)})`;

export function stageCard(geometry: StageGeometry): StageRect {
  return geometry.fullscreen ? { x: 0, y: 0, width: geometry.width, height: geometry.height } : geometry.card;
}

export function collapsedTransform(geometry: StageGeometry) {
  const card = stageCard(geometry);
  const source = geometry.source ?? card;
  return affine(source.x + source.width / 2 - (card.x + card.width / 2), source.y + source.height / 2 - (card.y + card.height / 2), START_SCALE, START_SCALE);
}

export function expandedTransform(geometry: StageGeometry) {
  const card = stageCard(geometry);
  return affine(geometry.width / 2 - (card.x + card.width / 2), geometry.height / 2 - (card.y + card.height / 2), geometry.width / Math.max(card.width, 1), geometry.height / Math.max(card.height, 1));
}

export function stageMotion(move: StageMove, geometry: StageGeometry, reduceMotion: boolean): StageMotion {
  const snap = reduceMotion || geometry.fullscreen;
  const collapsed = collapsedTransform(geometry);
  if (move === "enter") {
    const card = snap ? [{ transform: IDENTITY, opacity: 1 }] : [{ transform: collapsed, opacity: 0 }, { opacity: 1, offset: 0.35 }, { transform: IDENTITY, opacity: 1 }];
    return { card, scrim: snap ? [{ opacity: 1 }] : [{ opacity: 0 }, { opacity: 1 }], duration: snap ? 0 : ENTER_MS, easing: ENTER_EASING };
  }
  if (move === "close") {
    return { card: snap ? [{ transform: IDENTITY, opacity: 0 }] : [{ transform: IDENTITY, opacity: 1 }, { transform: collapsed, opacity: 0 }], scrim: snap ? [{ opacity: 0 }] : [{ opacity: 1 }, { opacity: 0 }], duration: snap ? 0 : STEP_MS, easing: CLOSE_EASING };
  }
  const expanded = expandedTransform(geometry);
  return { card: snap ? [{ transform: expanded, opacity: 1 }] : [{ transform: IDENTITY, opacity: 1 }, { transform: expanded, opacity: 1 }], scrim: snap ? [{ opacity: 0 }] : [{ opacity: 1 }, { opacity: 0 }], duration: snap ? 0 : STEP_MS, easing: PROMOTE_EASING };
}

export const compositorOnly = (frames: readonly object[]) => frames.every((frame) => Object.keys(frame).every((key) => COMPOSITOR_PROPERTIES.has(key)));

export type StageAnimator = {
  run(move: StageMove, motion: StageMotion): Promise<void>;
  cancel(): void;
  hold(): void;
  release(): void;
};

type AnimatedNode = {
  animate?: (frames: Keyframe[], options: KeyframeAnimationOptions) => Playing;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

type Playing = Pick<Animation, "cancel" | "finished"> & { currentTime?: CSSNumberish | null };
export type LivePresentation = { transform?: string; opacity?: number };
type PresentationReader = (node: AnimatedNode) => LivePresentation | null;

export function computedPresentation(node: AnimatedNode): LivePresentation | null {
  if (typeof getComputedStyle !== "function") return null;
  const style = getComputedStyle(node as unknown as Element);
  const opacity = Number.parseFloat(style.opacity);
  return { transform: !style.transform || style.transform === "none" ? IDENTITY : style.transform, ...(Number.isFinite(opacity) ? { opacity } : {}) };
}

export function continuedMotion(motion: StageMotion, from: { card: LivePresentation | null; scrim: LivePresentation | null }, elapsed: number): StageMotion {
  if (motion.duration <= 0) return motion;
  const startFrom = (frames: StageFrame[], live: LivePresentation | null) => {
    if (!live || frames.length < 2) return frames;
    const first: StageFrame = {};
    if (frames[0]!.transform !== undefined && live.transform !== undefined) first.transform = live.transform;
    if (frames[0]!.opacity !== undefined && live.opacity !== undefined) first.opacity = live.opacity;
    return [{ ...frames[0]!, ...first }, ...frames.slice(1)];
  };
  const fraction = Math.min(Math.max(Number.isFinite(elapsed) ? elapsed : 1, 0), 1);
  return { ...motion, card: startFrom(motion.card, from.card), scrim: startFrom(motion.scrim, from.scrim), duration: Math.round(motion.duration * fraction) };
}

export function createWebAnimator(root: () => AnimatedNode | null, card: () => AnimatedNode | null, scrim: () => AnimatedNode | null, settledBounds: () => void, presentation: PresentationReader = computedPresentation): StageAnimator {
  let running: Playing[] = [];
  let current: { move: StageMove; duration: number; lead: Playing | null } | null = null;
  let holder: AnimatedNode | null = null;
  const cancelAll = () => {
    const stopping = running;
    running = [];
    current = null;
    for (const animation of stopping) animation.cancel();
  };
  const play = (node: AnimatedNode | null, frames: StageFrame[], motion: StageMotion) => {
    if (!node?.animate) return null;
    const keyframes = frames.length === 1 ? [frames[0]!, frames[0]!] : frames;
    const animation = node.animate(keyframes as Keyframe[], { duration: motion.duration, easing: motion.easing, fill: "forwards" });
    animation.finished.catch(() => {});
    return animation;
  };
  return {
    hold() {
      const node = root();
      if (holder === node) return;
      holder?.removeAttribute(PEEK_MOVING_ATTRIBUTE);
      holder = node;
      holder?.setAttribute(PEEK_MOVING_ATTRIBUTE, "");
    },
    release() {
      if (!holder) return;
      holder.removeAttribute(PEEK_MOVING_ATTRIBUTE);
      holder = null;
      settledBounds();
    },
    cancel: cancelAll,
    run(move, requested) {
      let motion = requested;
      if (running.length && current) {
        const cardNode = card();
        const scrimNode = scrim();
        const live = { card: cardNode ? presentation(cardNode) : null, scrim: scrimNode ? presentation(scrimNode) : null };
        const time = Number(current.lead?.currentTime ?? Number.NaN);
        const elapsed = current.duration > 0 && Number.isFinite(time) ? time / current.duration : 1;
        motion = continuedMotion(requested, live, current.move === "enter" && move === "close" ? elapsed : 1);
      }
      cancelAll();
      const started: Playing[] = [];
      running = started;
      current = { move, duration: motion.duration, lead: null };
      try {
        for (const [node, frames] of [[card(), motion.card], [scrim(), motion.scrim]] as const) {
          const animation = play(node, frames, motion);
          if (animation) started.push(animation);
        }
        current.lead = started[0] ?? null;
      } catch (error) {
        if (running === started) cancelAll();
        return Promise.reject(error);
      }
      const interrupted = () => {
        if (running === started) cancelAll();
      };
      return Promise.allSettled(started.map((animation) => animation.finished.catch((error: unknown) => {
        interrupted();
        throw error;
      }))).then((results) => {
        if (results.some((result) => result.status === "rejected")) throw new Error("peek stage animation interrupted");
      });
    },
  };
}

export type StageEvents = {
  state(phase: StagePhase, generation: number, entrance: StageEntrance): void;
  done(generation: number, outcome: StageOutcome): void;
};

export function createStageController(animator: StageAnimator, events: StageEvents, current: () => { geometry: StageGeometry; reduceMotion: boolean }) {
  let generation = 0;
  let phase: StagePhase = "waiting";
  let run = 0;
  const entrance = (): StageEntrance => (current().reduceMotion ? "fade" : "affine");
  const announce = (next: StagePhase) => {
    phase = next;
    events.state(next, generation, entrance());
  };
  const live = () => phase === "entering" || phase === "open";
  const play = (move: StageMove, animated: boolean, settled: () => void) => {
    const mine = ++run;
    const { geometry, reduceMotion } = current();
    const motion = stageMotion(move, geometry, reduceMotion || !animated);
    animator.hold();
    const end = () => {
      if (mine !== run) return;
      settled();
      animator.release();
    };
    let moving: Promise<void>;
    try {
      moving = animator.run(move, motion);
    } catch (error) {
      moving = Promise.reject(error);
    }
    void moving.then(end, end);
  };
  return {
    phase: () => phase,
    generation: () => generation,
    begin(next: number, animated = true) {
      if (next <= generation) return false;
      generation = next;
      announce("entering");
      play("enter", animated, () => phase === "entering" && announce("open"));
      return true;
    },
    close(at: number) {
      if (at !== generation || !live()) return false;
      announce("closing");
      play("close", true, () => finish(at, "closed"));
      return true;
    },
    promote(at: number) {
      if (at !== generation || !live()) return false;
      announce("promoting");
      play("promote", true, () => finish(at, "promoted"));
      return true;
    },
    dispose() {
      run++;
      animator.cancel();
      animator.release();
    },
  };
  function finish(at: number, outcome: StageOutcome) {
    if (at !== generation || phase === "finished") return;
    announce("finished");
    events.done(at, outcome);
  }
}

export type BoundsCommit<T> = {
  offer(value: T): void;
  hold(): void;
  release(): void;
  held(): boolean;
};

export function createBoundsCommit<T>(publish: (value: T) => void): BoundsCommit<T> {
  let held = false;
  let pending: { value: T } | null = null;
  return {
    offer(value) {
      if (held) pending = { value };
      else publish(value);
    },
    hold() {
      held = true;
    },
    release() {
      if (!held) return;
      held = false;
      const next = pending;
      pending = null;
      if (next) publish(next.value);
    },
    held: () => held,
  };
}
