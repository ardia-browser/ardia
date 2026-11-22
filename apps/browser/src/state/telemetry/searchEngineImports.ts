import { capture, type ConsentToken } from "./client";

export type SearchEngineImportOutcome = "built_in" | "custom" | "source_default" | "unusable";

export const noteSearchEngineImport = (source: string, outcome: SearchEngineImportOutcome, changed: boolean, offered: boolean, consent: ConsentToken | null) =>
  capture("search_engine_import", { source, outcome, changed, offered }, consent);
