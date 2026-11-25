type HermesStats = { js_heapSize?: number; js_numGCs?: number; js_gcTime?: number };
type HermesGlobal = { HermesInternal?: { getInstrumentedStats?: () => HermesStats } };

const hermesStats = (): HermesStats | undefined => (globalThis as HermesGlobal).HermesInternal?.getInstrumentedStats?.();
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function hermesHeapBytes(): number | null {
  try {
    const size = hermesStats()?.js_heapSize;
    return isCount(size) ? size : null;
  } catch {
    return null;
  }
}

export const hermesHeapMegabytes = (): number | null => {
  const bytes = hermesHeapBytes();
  return bytes === null ? null : Math.round(bytes / (1024 * 1024));
};

export function hermesCollections(): { count: number; ms: number } | null {
  try {
    const stats = hermesStats();
    return stats && isCount(stats.js_numGCs) && isCount(stats.js_gcTime) ? { count: stats.js_numGCs, ms: stats.js_gcTime * 1000 } : null;
  } catch {
    return null;
  }
}
