import type { JsonSchema } from "../../lib/jsonSchema";
import type { LibrarySection } from "./library";

export type LibraryListSection = Exclude<LibrarySection, "profiles">;
export type LibraryView = "list" | "cards";
export type LibraryViews = Record<LibraryListSection, LibraryView>;

export const LIBRARY_LIST_SECTIONS: readonly LibraryListSection[] = ["media", "downloads", "history"];
export const LIBRARY_VIEWS: readonly LibraryView[] = ["list", "cards"];
export const DEFAULT_LIBRARY_VIEWS: LibraryViews = { media: "cards", downloads: "list", history: "list" };

export const isLibraryViews = (v: unknown): v is LibraryViews =>
  typeof v === "object" && v !== null && LIBRARY_LIST_SECTIONS.every((section) => LIBRARY_VIEWS.includes((v as Record<string, unknown>)[section] as LibraryView));

const VIEW_SCHEMA: JsonSchema = { type: "string", enum: [...LIBRARY_VIEWS] };

export const LIBRARY_VIEWS_SCHEMA: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(LIBRARY_LIST_SECTIONS.map((section) => [section, VIEW_SCHEMA])),
  required: [...LIBRARY_LIST_SECTIONS],
};

export const libraryViewOf = (views: LibraryViews, section: LibraryListSection): LibraryView => views[section] ?? DEFAULT_LIBRARY_VIEWS[section];
