import type { RendererEfficiencyCounts, RendererEfficiencyNative } from "@ardia/shell";
import { engineAvailable, hostCall } from "./host";

const REFRESH_MS = 60_000;
const KEYS = ["throttled", "restored", "failed", "exemptCall", "exemptCapture", "exemptPictureInPicture", "exemptAudio"] as const;

type Reply = { counts?: unknown } | null | undefined;
type Ask = () => Promise<Reply>;
type Timers = { every(run: () => void, ms: number): unknown; cancel(handle: unknown): void };

const realTimers: Timers = {
  every: (run, ms) => setInterval(run, ms),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const zero = (): RendererEfficiencyCounts => ({ throttled: 0, restored: 0, failed: 0, exemptCall: 0, exemptCapture: 0, exemptPictureInPicture: 0, exemptAudio: 0 });
const UNSUPPORTED = "unknown verb";

const unsupportedBy = (error: unknown) => error instanceof Error && error.message === UNSUPPORTED;
const counted = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

export function rendererEfficiencyCounts(ask: Ask, available: () => boolean, every = REFRESH_MS, timers: Timers = realTimers) {
  let held: Record<string, RendererEfficiencyCounts> = {};
  let epoch = "";
  let generation = 0;
  let refreshing: Promise<void> | null = null;
  let timer: unknown = null;
  let unsupported = false;
  const asking = () => available() && !unsupported;

  function noteUnsupported(error: unknown) {
    if (!unsupportedBy(error)) return;
    unsupported = true;
    stop();
  }

  function stop() {
    if (timer !== null) timers.cancel(timer);
    timer = null;
  }

  function watch() {
    if (timer === null && epoch && asking()) timer = timers.every(() => void refresh(), every);
  }

  function request(): Promise<void> {
    const askedIn = generation;
    const askedFor = epoch;
    return ask()
      .then((reply) => {
        if (askedIn !== generation || !askedFor) return;
        const counts = reply?.counts;
        const fields = typeof counts === "object" && counts !== null ? (counts as Record<string, unknown>) : {};
        if (!KEYS.some((key) => counted(fields[key]))) return;
        const into = (held[askedFor] ??= zero());
        for (const key of KEYS) into[key] += counted(fields[key]);
      })
      .catch(noteUnsupported);
  }

  function refresh(): Promise<void> {
    if (!asking()) return Promise.resolve();
    refreshing ??= request().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const counts: RendererEfficiencyNative & { refresh(): Promise<void>; stop(): void } = {
    takeCounts() {
      watch();
      const taken = held;
      held = {};
      void refresh();
      return taken;
    },
    setConsentEpoch(next) {
      if (next === epoch) return;
      epoch = next;
      generation += 1;
      held = {};
      if (asking()) void ask().catch(noteUnsupported);
      if (next) watch();
      else stop();
    },
    refresh,
    stop,
  };
  return counts;
}

export const windowsRendererEfficiency = rendererEfficiencyCounts(() => hostCall<Reply>("renderer.efficiencyCounts"), engineAvailable);
