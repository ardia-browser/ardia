import type { ChromeSearchEngine } from "../../extensions";
import type { Done, Profile } from "../wire";

export type SearchCalls = {
  "search.engines": [Profile, { list: { engines: ChromeSearchEngine[] } }];
  "search.setEngineName": [{ name: string; keyword?: string; url?: string }, null];
  "search.suggest": [Profile & { url: string; id: number }, { status: number; body?: string; netError?: number; stopped?: true }];
  "search.stopSuggest": [Profile & { id: number }, Done];
};

export type SearchEvents = {};
