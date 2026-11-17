type HermesStats = { js_heapSize?: number };
type HermesGlobal = { HermesInternal?: { getInstrumentedStats?: () => HermesStats } };

export function hermesHeapBytes(): number | null {
  try {
    const size = (globalThis as HermesGlobal).HermesInternal?.getInstrumentedStats?.().js_heapSize;
    return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

export const hermesHeapMegabytes = (): number | null => {
  const bytes = hermesHeapBytes();
  return bytes === null ? null : Math.round(bytes / (1024 * 1024));
};
