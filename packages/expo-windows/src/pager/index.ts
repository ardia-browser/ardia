import { cancelFrame, noteAnimation, requestFrame } from "../animation/motion";
import { animationEffectsOff } from "../animation/reduceMotion";
import { PagerRegistry, type PagerSnapshot } from "./pager";

export const pagers = new PagerRegistry({
  now: () => performance.now(),
  requestFrame,
  cancelFrame,
  reducedMotion: animationEffectsOff,
  startMotion: () => {
    const running = { __active: true };
    noteAnimation(running);
    return () => void (running.__active = false);
  },
});

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((id) => typeof id === "string") ? (value as string[]) : undefined;

export const windowsSwipe = {
  haptic(_pattern: string) {},
  switchPager(key: string, index: number, order?: readonly string[] | null): Promise<boolean> {
    return Promise.resolve(pagers.existing(key)?.switchTo(Math.trunc(index), strings(order)) ?? false);
  },
  stepPager(key: string, delta: number, wrap: boolean, order?: readonly string[] | null): Promise<boolean> {
    return Promise.resolve(pagers.existing(key)?.step(Math.trunc(delta), !!wrap, strings(order)) ?? false);
  },
  selectPager(key: string, profileId: string, order: readonly string[]): Promise<boolean> {
    const ids = strings(order);
    return Promise.resolve(ids ? (pagers.existing(key)?.select(profileId, ids) ?? false) : false);
  },
  pagerState(key: string): PagerSnapshot | null {
    return pagers.snapshot(key);
  },
  devPagerState(key: string): Promise<unknown> {
    return Promise.resolve(pagers.existing(key)?.debug() ?? null);
  },
  devSimulate(): Promise<unknown> {
    return Promise.resolve({ error: "swipe gestures have no Windows version yet" });
  },
};
