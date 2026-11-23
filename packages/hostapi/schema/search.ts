import { defineDomain } from "../define.ts";

export const search = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Done", "Profile"],
    "../../extensions": ["ChromeSearchEngine"],
  },
  calls: {
    engines: {
      args: "Profile",
      result: "{ list: { engines: ChromeSearchEngine[] } }",
      service: "ac_search_engines_list",
      desktop: "route",
      mac: "custom",
      windows: "custom",
    },
    setEngineName: {
      args: "{ name: string; keyword?: string; url?: string }",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    suggest: {
      args: "Profile & { url: string; id: number }",
      result: "{ status: number; body?: string; netError?: number; stopped?: true }",
      service: "ac_search_suggest",
      desktop: "absent",
    },
    stopSuggest: {
      args: "Profile & { id: number }",
      result: "Done",
      service: "ac_search_suggest_stop",
      desktop: "absent",
    },
  },
  events: {},
});
