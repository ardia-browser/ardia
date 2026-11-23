import { defineDomain } from "../define.ts";

export const history = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Done", "Profile"],
    "../../history": ["HistoryChangedBatch", "HistoryWireRow"],
  },
  calls: {
    query: {
      args: "Profile & { maxUrls: number; maxVisits: number }",
      result: "{ entries: (HistoryWireRow & { v: number[] })[] }",
      service: "ac_history_query",
      desktop: "route",
    },
    add: {
      args: "Profile & { pages: { u: string; t: string; v: number[] }[]; toleranceMs: number }",
      result: "{ added: number }",
      service: "ac_history_add",
      desktop: "route",
    },
    import: {
      args: "Profile & { rows: { u: string; t: string; n: number; l: number }[] }",
      result: "Done",
      service: "ac_history_import",
      desktop: "route",
    },
    deleteUrls: {
      args: "Profile & { urls: string[] }",
      result: "Done",
      service: "ac_history_delete_urls",
      desktop: "route",
    },
    watch: {
      args: "Profile",
      result: "Done",
      service: "ac_history_watch",
      desktop: "route",
    },
  },
  events: {
    changed: "HistoryChangedBatch",
  },
});
