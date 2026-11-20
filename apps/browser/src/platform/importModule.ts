import type * as ImportApi from "@ardia/import";

export type {
  ArcArchive,
  ArcArchivedTab,
  ArcLinkDestination,
  ArcLinkRule,
  ArcRouting,
  BookmarkNode,
  BrowserProfile,
  BrowserSource,
  Credential,
  DiaTabsProfile,
  DiaTabsResult,
  ImportedExtension,
  ImportedExtensionSkip,
  ImportedFavicon,
  ImportedSearchEngine,
  ImportedTab,
  ImportKind,
  ImportResult,
  SafariExport,
  SpaceSuggestion,
  SpaceSummary,
} from "@ardia/import";

let api: typeof ImportApi | undefined;

export const importModule = (): typeof ImportApi => (api ??= require("@ardia/import") as typeof ImportApi);
