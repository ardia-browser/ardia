import type { StripDragTarget } from "./stripDrag";

export function createStripDrags() {
  let active: StripDragTarget | null = null;
  return {
    track(target: StripDragTarget): StripDragTarget {
      return {
        press: () => target.press(),
        begin(x, y) {
          if (active && active !== target) active.cancel();
          active = target;
          target.begin(x, y);
        },
        move: (x, y) => target.move(x, y),
        end(commit) {
          target.end(commit);
          if (active === target) active = null;
        },
        cancel() {
          target.cancel();
          if (active === target) active = null;
        },
      };
    },
    cancelAll() {
      const was = active;
      active = null;
      was?.cancel();
    },
  };
}
