import type { HistoryChangedBatch, HistoryWireRow } from "../../history";
import type { Done, Profile } from "../wire";

export type HistoryCalls = {
  "history.query": [Profile & { maxUrls: number; maxVisits: number }, { entries: (HistoryWireRow & { v: number[] })[] }];
  "history.add": [Profile & { pages: { u: string; t: string; v: number[] }[]; toleranceMs: number }, { added: number }];
  "history.import": [Profile & { rows: { u: string; t: string; n: number; l: number }[] }, Done];
  "history.deleteUrls": [Profile & { urls: string[] }, Done];
  "history.watch": [Profile, Done];
};

export type HistoryEvents = {
  "history.changed": HistoryChangedBatch;
};
