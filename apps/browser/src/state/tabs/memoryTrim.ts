import { keysOf } from "../browser/changes";
import { hermesHeapBytes } from "../../lib/hermesHeap";
import { inputIdleSeconds, trimEngineMemory } from "../../platform/performance";
import { useBrowser } from "../browser/store";
import { isQuitting } from "../app/quit";
import { noteHeapCollection, noteMemoryTrim, noteMemoryTrimFailure, noteMemoryTrimGivenUp } from "../telemetry/memoryTrimCounts";
import { during } from "../app/jobActivity";

const QUIET_MS = 5000;
const MIN_GAP_MS = 30000;
const STEP_MS = 250;
const BUSY_RETRY_MS = 1000;
const MAX_COLLECTIONS = 8;
const MAX_POSTPONES = 30;
const INPUT_IDLE_SECONDS = 2;
const TIMER_LATE_MS = 50;
const SLOW_COLLECTION_MS = 100;

const runtime = globalThis as { gc?: () => void };

const heapSize = hermesHeapBytes;

let started = false;

export function startMemoryTrim() {
  if (started) return;
  const compactsHeap = typeof runtime.gc === "function" && heapSize() !== null;
  started = true;

  let tabCount = Object.keys(useBrowser.getState().tabs).length;
  let collectionsSlow = false;
  let lastTrimAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const later = (fn: (lateMs: number) => void, ms: number) => {
    const due = Date.now() + ms;
    timer = setTimeout(() => {
      timer = null;
      fn(Date.now() - due);
    }, ms);
  };

  const idle = (lateMs: number) => lateMs < TIMER_LATE_MS && (inputIdleSeconds() ?? Infinity) >= INPUT_IDLE_SECONDS;

  const finish = () => {
    if (isQuitting()) return;
    trimEngineMemory().then(noteMemoryTrim, noteMemoryTrimFailure);
  };

  const compact = (step: number, before: number, postponed: number, lateMs: number) => {
    if (isQuitting()) return;
    if (!idle(lateMs)) {
      if (postponed < MAX_POSTPONES) later((late) => compact(step, before, postponed + 1, late), BUSY_RETRY_MS);
      else noteMemoryTrimGivenUp();
      return;
    }
    const collectedFrom = Date.now();
    during("memoryTrim", () => runtime.gc!());
    const collectionMs = Date.now() - collectedFrom;
    const slow = collectionMs > SLOW_COLLECTION_MS;
    collectionsSlow ||= slow;
    noteHeapCollection(collectionMs, slow);
    const after = heapSize() ?? before;
    if (!slow && after < before && step + 1 < MAX_COLLECTIONS) later((late) => compact(step + 1, after, postponed, late), STEP_MS);
    else finish();
  };

  const begin = (lateMs: number, postponed = 0) => {
    if (isQuitting()) return;
    const wait = lastTrimAt + MIN_GAP_MS - Date.now();
    if (wait > 0) return later((late) => begin(late, postponed), wait);
    if (!idle(lateMs)) {
      if (postponed < MAX_POSTPONES) later((late) => begin(late, postponed + 1), BUSY_RETRY_MS);
      else noteMemoryTrimGivenUp();
      return;
    }
    lastTrimAt = Date.now();
    if (compactsHeap && !collectionsSlow) compact(0, heapSize() ?? 0, 0, 0);
    else finish();
  };

  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    const count = keysOf(s.tabs).length;
    if (count === tabCount) return;
    tabCount = count;
    cancel();
    later(begin, QUIET_MS);
  });
}
