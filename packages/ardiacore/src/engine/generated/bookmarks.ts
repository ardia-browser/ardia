import type { BookmarkOp, EngineBookmark } from "../../bookmarks";
import type { Done, Profile } from "../wire";

export type BookmarksCalls = {
  "bookmarks.tree": [Profile, { bar: EngineBookmark; other: EngineBookmark }];
  "bookmarks.apply": [Profile & { ops: BookmarkOp[] }, { applied: number; skipped: number; invalid: string[] }];
  "bookmarks.watch": [Profile, Done];
  "bookmarks.exportHtml": [Profile, string | null];
};

export type BookmarksEvents = {
  "bookmarks.changed": { profile: string };
};
