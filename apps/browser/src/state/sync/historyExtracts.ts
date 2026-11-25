import type { HistoryEntry } from "../browser/types";
import type { HistoryValue } from "./records";

type ExtractedVisit = { key: string | null; json: string | undefined; value: HistoryValue | null };
type HistoryExtracts = { parsed: Map<string, { json: string; known: HistoryValue | null }>; knownJson: WeakMap<HistoryValue, string>; visits: WeakMap<HistoryEntry, ExtractedVisit> };

const historyExtracts = new Map<string, HistoryExtracts>();

export function historyExtractsOf(profileId: string): HistoryExtracts {
  let extracts = historyExtracts.get(profileId);
  if (!extracts) historyExtracts.set(profileId, (extracts = { parsed: new Map(), knownJson: new WeakMap(), visits: new WeakMap() }));
  return extracts;
}
