export const MIN_FRAME_INTERVAL = 0.9 / 60;

export type ViewClock = { css: [number, number]; time: number; started: boolean; pending: number };

export type FrameStep = "unmeasured" | "skip" | "draw" | "finish";

export function measuredSize(width: number, height: number, devicePixelRatio: number): { css: [number, number]; pixels: [number, number] } | null {
  if (!(width > 0 && height > 0)) return null;
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { css: [width, height], pixels: [Math.round(width * scale), Math.round(height * scale)] };
}

export const hasSize = (css: readonly [number, number]) => css[0] > 0 && css[1] > 0;

export function stepAnimation(clock: ViewClock, dt: number, lastFrameTime: number): FrameStep {
  if (!hasSize(clock.css)) {
    clock.pending = 0;
    return "unmeasured";
  }
  clock.pending += dt;
  if (clock.started && clock.pending < MIN_FRAME_INTERVAL) return "skip";
  clock.time = clock.started ? clock.time + clock.pending : 0;
  clock.pending = 0;
  clock.started = true;
  if (clock.time < lastFrameTime) return "draw";
  clock.time = lastFrameTime;
  return "finish";
}

export const wantsFrames = (visible: boolean, css: readonly [number, number], done: boolean) => visible && hasSize(css) && !done;

export function frameSubscription(subscribe: () => () => void): { sync: (wanted: boolean) => void; active: () => boolean } {
  let stop: (() => void) | null = null;
  return {
    sync: (wanted) => {
      if (wanted && !stop) stop = subscribe();
      else if (!wanted && stop) {
        const current = stop;
        stop = null;
        current();
      }
    },
    active: () => stop !== null,
  };
}
