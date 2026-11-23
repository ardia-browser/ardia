import { defineDomain } from "../define.ts";

export const bookmarks = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Done", "Profile"],
    "../../bookmarks": ["BookmarkOp", "EngineBookmark"],
  },
  calls: {
    tree: {
      args: "Profile",
      result: "{ bar: EngineBookmark; other: EngineBookmark }",
      service: "ac_bookmarks_tree",
      desktop: "route",
    },
    apply: {
      args: "Profile & { ops: BookmarkOp[] }",
      result: "{ applied: number; skipped: number; invalid: string[] }",
      service: "ac_bookmarks_apply",
      desktop: "route",
    },
    watch: {
      args: "Profile",
      result: "Done",
      service: "ac_bookmarks_watch",
      desktop: "route",
    },
    exportHtml: {
      args: "Profile",
      result: "string | null",
      service: "ac_bookmarks_export_html",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
  },
  events: {
    changed: {
      payload: "{ profile: string }",
      desktop: "forward",
    },
  },
});
