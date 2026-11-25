import type { MediaAccess } from "../../platform/tabs";
import { usePages } from "../tabs/pageState";
import { live, useLive } from "./store";

type Pages = ReturnType<typeof usePages.getState>;

export const capturing = (access: MediaAccess | null | undefined) => !!access && (access.camera || access.microphone || access.screen);

const captureEnded = (p: Pages, prev: Pages) =>
  p.pages !== prev.pages && Object.keys(prev.pages).some((id) => capturing(prev.pages[id]?.mediaAccess) && !capturing(p.pages[id]?.mediaAccess));

export function whenCaptureEndsUnderHiddenCompleted(then: () => void) {
  let stop: (() => void) | null = null;
  const watch = () => {
    const needed = Object.values(live().folders).some((f) => f.showCompleted === false);
    if (needed) stop ??= usePages.subscribe((p, prev) => captureEnded(p, prev) && then());
    else stop = (stop?.(), null);
  };
  watch();
  useLive.subscribe((s, prev) => s.folders !== prev.folders && watch());
}
