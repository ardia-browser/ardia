import { useSearch } from "./store";

export const useSearchOpen = () => useSearch((s) => s.open);
export const useSearchFromDockedMenu = () => useSearch((s) => s.arrival === "dockedMenu");
export const useSearchEnding = () => useSearch((s) => s.ending);
export const useSearchOrigin = () => useSearch((s) => s.origin);
export const useSearchEditsPage = () => useSearch((s) => s.editsPage);
export const useSearchSession = () => useSearch((s) => s.session);
export const useSearchInitialText = () => useSearch((s) => s.initialText);
export const useSearchText = () => useSearch((s) => s.text);
export const useSearchRows = () => useSearch((s) => s.rows);
export const useSearchFieldVersion = () => useSearch((s) => s.fieldVersion);
export const useSearchCompletion = () => useSearch((s) => s.completion);
export const useSearchCompletedFor = () => useSearch((s) => s.completedFor);
