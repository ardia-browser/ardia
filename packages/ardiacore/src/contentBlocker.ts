export type FilterListCategory = "ads" | "trackers" | "cookies" | "regional" | "annoyances" | "security" | "custom";

export type FilterList = {
  id: string;
  title: string;
  category: FilterListCategory;
  enabled: boolean;
  defaultOn: boolean;
  filters: number;
  failed?: boolean;
};

export type AddedFilterList = {
  id: string;
  custom: boolean;
  existed: boolean;
  filters: number;
  failed: boolean;
};

export type ContentBlockerStats = {
  ready: boolean;
  enabled: boolean;
  networkFilters?: number;
  cosmeticFilters?: number;
  unsupportedFilters?: number;
  parseMs: number;
  lookups: number;
  averageLookupMicros: number;
  maxLookupMicros: number;
  error?: string;
};

export type ContentBlockerState = {
  enabled: boolean;
  version: string;
  lists: FilterList[];
  allowedHosts: string[];
  stats: ContentBlockerStats;
};
