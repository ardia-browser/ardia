import { useEffect } from "react";
import { snapTarget } from "../../lib/pagerPhysics";
import { launchArguments } from "../../state/app/launchFlags";
import type { TabPager } from "./TabPager";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const DRAG_STEPS_PER_SECOND = 120;
const DRAG_STEP_MS = 8;

export function useDemoMotion(pager: TabPager, width: number) {
  useEffect(() => {
    const launch = launchArguments();
    if (launch.pagerFreeze === null && !launch.pagerScript) return;
    let live = true;
    const drag = async (fraction: number, seconds: number) => {
      const start = pager.offset.value;
      const steps = Math.max(Math.trunc(seconds * DRAG_STEPS_PER_SECOND), 1);
      for (let index = 1; index <= steps && live; index++) {
        pager.track(start + (fraction * width - start) * (index / steps));
        await wait(DRAG_STEP_MS);
      }
    };
    void (async () => {
      await wait(launch.browseDelayMs);
      if (!live) return;
      if (launch.pagerFreeze !== null) {
        if (pager.grab()) pager.track(-launch.pagerFreeze * width);
        return;
      }
      if (!pager.grab()) return;
      await drag(0.25, 0.3);
      pager.settleTo(0, 0);
      await wait(1200);
      if (!live || !pager.grab()) return;
      await drag(-0.3, 0.25);
      pager.settleTo(snapTarget(pager.offset.value, -1400, width, true, true), -1400);
      await wait(1500);
      if (!live || !pager.grab()) return;
      await drag(0.3, 0.25);
      pager.settleTo(1, 1400);
      await wait(120);
      if (!live || !pager.grab()) return;
      await drag(0.1, 0.2);
      pager.settleTo(0, -300);
    })();
    return () => {
      live = false;
    };
  }, []);
}
