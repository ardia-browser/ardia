import type { Timers } from "./storage";

export type CountStore = { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };

export const COUNTS_KEY = "counts";
const MAX_KEYS = 400;
const FLUSH_MS = 2000;

export class Counts {
  private values: Record<string, number> = {};
  private loaded: Promise<void>;
  private timer: unknown = null;

  constructor(
    private readonly store: CountStore,
    private readonly timers: Pick<Timers, "setTimeout" | "clearTimeout">,
  ) {
    this.loaded = store
      .get<Record<string, number>>(COUNTS_KEY)
      .then((saved) => {
        if (!saved || typeof saved !== "object") return;
        for (const [key, value] of Object.entries(saved)) if (typeof value === "number" && Number.isFinite(value) && value > 0) this.values[key] = (this.values[key] ?? 0) + Math.floor(value);
      })
      .catch(() => undefined);
  }

  bump(key: string, by = 1) {
    if (!/^[a-z0-9_]{1,80}$/.test(key)) return;
    if (!(key in this.values) && Object.keys(this.values).length >= MAX_KEYS) return;
    this.values[key] = (this.values[key] ?? 0) + by;
    this.timer ??= this.timers.setTimeout(() => void this.flush(), FLUSH_MS);
  }

  async snapshot(): Promise<Record<string, number>> {
    await this.loaded;
    return { ...this.values };
  }

  async flush() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.loaded;
    await this.store.set(COUNTS_KEY, { ...this.values }).catch(() => undefined);
  }
}
