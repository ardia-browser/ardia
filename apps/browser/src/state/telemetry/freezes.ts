import { freezeWatch, type StallTally } from "../../platform/freezeWatch";
import { experimentOn } from "../../platform/killSwitches";
import { isSharing, onConsentPeriodChange, stillValid, type ConsentToken } from "./choice";

export const STALL_BUCKETS = ["250_500ms", "500ms_1s", "1_2s", "2_5s", "5_10s", "over_10s"] as const;
const HEAP_FLOORS_MB = [0, 64, 128, 256, 512, 1024, 2048];
const HANG_BUCKETS = [
  [5_000, "under_5s"],
  [30_000, "5_30s"],
  [120_000, "30s_2m"],
  [Infinity, "over_2m"],
] as const;

type HermesStats = { js_numGCs?: unknown; js_gcTime?: unknown; js_heapSize?: unknown };
type HermesGlobal = { HermesInternal?: { getInstrumentedStats?: () => HermesStats } };
type GcTotals = { count: number; ms: number };
type OpenHang = { at: number; epoch: number };

const noHangs = () => ({
  renderer_unresponsive: 0,
  renderer_unresponsive_exited: 0,
  renderer_unresponsive_under_5s: 0,
  renderer_unresponsive_5_30s: 0,
  renderer_unresponsive_30s_2m: 0,
  renderer_unresponsive_over_2m: 0,
});

let epoch = 0;
let gcBase: GcTotals | null = null;
let hangs = noHangs();
const openHangs = new Map<string, OpenHang>();
let watching = false;
let followingConsent = false;

function hermesStats(): HermesStats | null {
  try {
    return (globalThis as HermesGlobal).HermesInternal?.getInstrumentedStats?.() ?? null;
  } catch {
    return null;
  }
}

function gcTotals(): GcTotals | null {
  const stats = hermesStats();
  return stats && typeof stats.js_numGCs === "number" && typeof stats.js_gcTime === "number" ? { count: stats.js_numGCs, ms: stats.js_gcTime * 1000 } : null;
}

export function heapFloorMb(bytes: number): number {
  const mb = bytes / 1_048_576;
  return HEAP_FLOORS_MB.reduce((floor, step) => (mb >= step ? step : floor), 0);
}

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export function stallFields(thread: "main" | "js", tally: StallTally | null | undefined): Record<string, number> {
  const fields: Record<string, number> = {};
  STALL_BUCKETS.forEach((bucket, i) => (fields[`${thread}_stall_${bucket}`] = whole(tally?.buckets?.[i])));
  fields[`${thread}_stall_longest_ms`] = whole(tally?.longestMs);
  fields[`${thread}_stall_input_waits`] = whole(tally?.inputWaits);
  fields[`${thread}_stall_input_wait_max_ms`] = whole(tally?.inputWaitMaxMs);
  if (thread === "js") {
    fields.js_stall_gc_measured = whole(tally?.gcMeasured);
    fields.js_stall_gc_ms = whole(tally?.gcMs);
    fields.js_stall_gc_longest_ms = whole(tally?.gcLongestMs);
    fields.js_stall_gc_bound = whole(tally?.gcBound);
  }
  return fields;
}

export const freezeEpoch = () => epoch;

const newEpoch = () => 1 + Math.floor(Math.random() * 0x7fff_fffe);

export function setFreezeConsent(sharing: boolean) {
  epoch = sharing ? newEpoch() : 0;
  if (watching) freezeWatch()?.setConsentEpoch(epoch);
  gcBase = sharing ? gcTotals() : null;
  hangs = noHangs();
  openHangs.clear();
}

function followConsent() {
  if (followingConsent) return;
  followingConsent = true;
  setFreezeConsent(isSharing());
  onConsentPeriodChange(() => setFreezeConsent(isSharing()));
}

export function startFreezeWatch(): boolean {
  followConsent();
  const watch = freezeWatch();
  if (watching || !watch || experimentOn("freezeWatchOff")) return false;
  watching = true;
  watch.start();
  watch.setConsentEpoch(epoch);
  return true;
}

export function noteRendererUnresponsive(tabId: string, at = Date.now()) {
  if (epoch && !openHangs.has(tabId)) openHangs.set(tabId, { at, epoch });
}

export function forgetRendererHang(tabId: string) {
  openHangs.delete(tabId);
}

export function noteRendererResponsive(tabId: string, exited: boolean, at = Date.now()) {
  const open = openHangs.get(tabId);
  openHangs.delete(tabId);
  if (!open || !epoch || open.epoch !== epoch) return;
  const ms = at - open.at;
  hangs.renderer_unresponsive++;
  if (exited) hangs.renderer_unresponsive_exited++;
  hangs[`renderer_unresponsive_${HANG_BUCKETS.find(([limit]) => ms < limit)![1]}`]++;
}

export function takeFreezeCounts(consent: ConsentToken | null): Record<string, number> {
  const tally = epoch ? (freezeWatch()?.take(epoch) ?? null) : null;
  const taken = hangs;
  hangs = noHangs();
  const gc = epoch ? gcTotals() : null;
  const base = gcBase;
  gcBase = gc;
  if (!epoch || !stillValid(consent)) return {};
  const fields: Record<string, number> = { ...(tally ? { ...stallFields("main", tally.main), ...stallFields("js", tally.js) } : {}), ...taken };
  if (watching && gc && base) {
    fields.js_gc_count = Math.max(0, gc.count - base.count);
    fields.js_gc_ms = Math.max(0, Math.round(gc.ms - base.ms));
  }
  const heap = hermesStats()?.js_heapSize;
  if (watching && typeof heap === "number" && heap >= 0) fields.js_heap_mb_floor = heapFloorMb(heap);
  return fields;
}
