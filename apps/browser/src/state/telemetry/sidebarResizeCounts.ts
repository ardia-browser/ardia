import { takeSidebarScrollCounts } from "./sidebarScrollCounts";

const SLOW_FRAME_MS = 25;

let resizes = 0;
let frames = 0;
let slowFrames = 0;
let watched: { frames: number; slow: number; last: number; request: number } | null = null;

export function watchSidebarResizeFrames() {
  if (watched) return;
  const watch = (watched = { frames: 0, slow: 0, last: -1, request: 0 });
  const tick = (at: number) => {
    if (watch.last >= 0) {
      watch.frames++;
      if (at - watch.last > SLOW_FRAME_MS) watch.slow++;
    }
    watch.last = at;
    watch.request = requestAnimationFrame(tick);
  };
  watch.request = requestAnimationFrame(tick);
}

export function noteSidebarResize(dragged: boolean) {
  const watch = watched;
  watched = null;
  if (watch) cancelAnimationFrame(watch.request);
  if (!dragged) return;
  resizes++;
  frames += watch?.frames ?? 0;
  slowFrames += watch?.slow ?? 0;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes, sidebar_resize_frames: frames, sidebar_resize_slow_frames: slowFrames, ...takeSidebarScrollCounts() };
  resizes = frames = slowFrames = 0;
  return taken;
}
