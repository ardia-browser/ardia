import { freezeWatch, onFreeze, type FreezeFrame, type FreezeRecord } from "../../platform/freezeWatch";
import { systemState } from "../../platform/performance";
import { withDeadline } from "../../lib/deadline";
import { activityDuring, holdsMainThread } from "../app/jobActivity";
import { useBrowser } from "../browser/store";
import { useSync } from "../sync/engine";
import { capture, stillValid, type ConsentToken } from "./client";
import { freezeEpoch, heapFloorMb } from "./freezes";
import { claimDailySend } from "./freezeSends";
import { journeyInFlight } from "./journeys";
import { nativeConsent } from "./nativeConsent";
import { nativeFrames, nativeImages, type NativeImage } from "./sanitize";

export const MAX_FREEZES_PER_SESSION = 5;
const FRAMES_SENT = 24;
const SIGNATURE_FRAMES = 3;
const OWN_IMAGE = /^(Ardia|Chromium Framework|hermes)/;
const KNOWN_IMAGE = /^(Ardia(\.debug\.dylib)?|Chromium Framework|hermes|system|other)$/;
const DURATIONS = [
  [1_000, "400ms_1s"],
  [2_000, "1_2s"],
  [5_000, "2_5s"],
  [10_000, "5_10s"],
  [30_000, "10_30s"],
  [Infinity, "over_30s"],
] as const;
const UPTIMES = [
  [5, "under_5m"],
  [60, "5_60m"],
  [360, "1_6h"],
  [1_440, "6_24h"],
  [Infinity, "over_24h"],
] as const;
const TAB_FLOORS = [0, 10, 25, 50, 100, 250, 500, 1000];
const THERMAL = ["nominal", "fair", "serious", "critical"] as const;
const CACHE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const startedAt = Date.now();

let sentThisSession = 0;
const signaturesThisSession = new Set<string>();

const bucket = <T extends string>(table: readonly (readonly [number, T])[], value: number) => table.find(([limit]) => value < limit)![1];

export function scrubFrames(frames: readonly FreezeFrame[]): FreezeFrame[] {
  return frames.slice(0, FRAMES_SENT).map((f) => ({
    image: typeof f.image === "string" && KNOWN_IMAGE.test(f.image) ? f.image : "other",
    offset: KNOWN_IMAGE.test(f.image) && f.image !== "other" && Number.isSafeInteger(f.offset) && f.offset >= 0 ? f.offset : 0,
  }));
}

export function systemCacheId(images: FreezeRecord["images"] | undefined): string | null {
  const id = Array.isArray(images) ? images.find((i) => i?.name === "system")?.uuid : undefined;
  return typeof id === "string" && CACHE_ID.test(id.toLowerCase()) ? id.toLowerCase() : null;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function freezeSignature(thread: string, frames: readonly FreezeFrame[], images: readonly NativeImage[] = []): string {
  const own = frames.filter((f) => OWN_IMAGE.test(f.image)).slice(0, SIGNATURE_FRAMES);
  const build = (image: string) => images.find((i) => i.name === image)?.uuid ?? "";
  return own.length ? `sig_${fnv1a(`${thread}|${own.map((f) => `${f.image}@${build(f.image)}+${f.offset.toString(16)}`).join("|")}`)}` : `none_${thread}`;
}

function allowedThisSession(signature: string) {
  return sentThisSession < MAX_FREEZES_PER_SESSION && !signaturesThisSession.has(signature);
}

function heapFloor(): number | null {
  try {
    const heap = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => { js_heapSize?: unknown } } }).HermesInternal?.getInstrumentedStats?.().js_heapSize;
    return typeof heap === "number" ? heapFloorMb(heap) : null;
  } catch {
    return null;
  }
}

export async function reportFreeze(record: FreezeRecord, consent: ConsentToken | null) {
  const end = record.startedAt + record.durationMs;
  const main = record.thread !== "js";
  const activity = activityDuring(record.startedAt, end, Date.now(), main ? holdsMainThread : undefined);
  const alongside = main ? activityDuring(record.startedAt, end, Date.now(), (a) => !holdsMainThread(a)) : null;
  if (activity !== "none") freezeWatch()?.annotate(record.id, activity);
  const epoch = freezeEpoch();
  if (!epoch || record.watchEpoch !== epoch || !stillValid(consent)) return;
  const frames = scrubFrames(record.samples[0]?.frames ?? []);
  const images = nativeImages(record.images);
  const signature = freezeSignature(record.thread, frames, images);
  if (!allowedThisSession(signature) || !claimDailySend(signature)) return;
  sentThisSession++;
  signaturesThisSession.add(signature);
  const system = await withDeadline(systemState(), 1_000, null).catch(() => null);
  if (!stillValid(consent) || freezeEpoch() !== epoch) return;
  const s = useBrowser.getState();
  const tabs = Object.keys(s.tabs).length;
  capture(
    "app_freeze",
    {
      freeze_thread: record.thread === "js" ? "js" : "main",
      freeze_duration: bucket(DURATIONS, record.durationMs),
      freeze_ms: Math.round(record.durationMs),
      input_wait_ms: Math.max(0, Math.round(record.inputWaitMs)),
      gc_ms: record.gcMs >= 0 ? Math.round(record.gcMs) : null,
      gc_count: typeof record.gcCount === "number" && record.gcCount >= 0 ? record.gcCount : null,
      heap_mb_floor: heapFloor(),
      activity,
      js_activity: alongside,
      tabs_floor: TAB_FLOORS.reduce((floor, step) => (tabs >= step ? step : floor), 0),
      windows: s.windowOrder.length,
      sync_on: useSync.getState().enabled,
      layout: s.settings.tabLayout === "top" ? "top" : "sidebar",
      action_in_flight: journeyInFlight(end),
      memory_pressure: system?.memoryPressure ?? null,
      thermal: THERMAL[record.thermal] ?? null,
      on_battery: system?.onBattery ?? null,
      uptime: bucket(UPTIMES, (Date.now() - startedAt) / 60_000),
      signature,
      samples: record.samples.length,
    },
    consent,
    { raw: { freeze_frames: nativeFrames(frames), freeze_images: images, freeze_system_cache: frames.some((f) => f.image === "system") ? systemCacheId(record.images) : null } },
  );
}

let watching = false;

export function watchFreezes() {
  if (watching) return;
  watching = true;
  onFreeze((record) => void reportFreeze(record, nativeConsent(record)).catch(() => {}));
}

export const resetFreezeEventsForTests = () => {
  sentThisSession = 0;
  signaturesThisSession.clear();
};
