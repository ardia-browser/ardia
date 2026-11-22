import { hermesCollections } from "../../lib/hermesHeap";

let trims = 0;
let failures = 0;
let givenUp = 0;
let slowCollections = 0;
let longestCollectionMs = 0;
let collectionsTaken = hermesCollections();

export const noteMemoryTrim = () => void (trims += 1);
export const noteMemoryTrimFailure = () => void (failures += 1);
export const noteMemoryTrimGivenUp = () => void (givenUp += 1);

export function noteHeapCollection(ms: number, slow: boolean) {
  if (slow) slowCollections += 1;
  longestCollectionMs = Math.max(longestCollectionMs, ms);
}

function takeCollections() {
  const now = hermesCollections();
  const since = collectionsTaken;
  collectionsTaken = now;
  if (!now || !since || now.count < since.count) return {};
  return { js_collections: now.count - since.count, js_collection_ms: Math.round(now.ms - since.ms) };
}

export function takeMemoryTrimCounts() {
  const taken = {
    engine_memory_trims: trims,
    engine_memory_trim_failures: failures,
    engine_memory_trims_given_up: givenUp,
    memory_trim_slow_collections: slowCollections,
    memory_trim_longest_collection_ms: longestCollectionMs,
    ...takeCollections(),
  };
  trims = 0;
  failures = 0;
  givenUp = 0;
  slowCollections = 0;
  longestCollectionMs = 0;
  return taken;
}
