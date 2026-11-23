import { defineDomain } from "../define.ts";

export const favicons = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Profile"],
    "../../favicons": ["FaviconImage"],
  },
  calls: {
    get: {
      args: "Profile & { pages: string[]; icons: string[]; size: number }",
      result: "{ pages: Record<string, { png: string; icon: string }>; icons: Record<string, { png: string }> }",
      service: "ac_favicons_get",
      desktop: "route",
    },
    set: {
      args: "Profile & { page: string; icon: string; png: string }",
      result: "{ stored: boolean }",
      service: "ac_favicons_set",
      desktop: "route",
    },
    fetch: {
      args: "Profile & { url: string }",
      result: "FaviconImage | null",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
  },
  events: {},
});
