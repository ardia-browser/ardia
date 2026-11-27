import { useEffect, useState } from "react";
import type { ImportSourceId } from "../../shared/importSources";

type SheetRequest = { source: ImportSourceId | null; at: number } | null;

let current: SheetRequest = null;
const listeners = new Set<(value: SheetRequest) => void>();

const emit = () => listeners.forEach((l) => l(current));

export function openImportSheet(source: ImportSourceId | null = null) {
  current = { source, at: Date.now() };
  emit();
}

export function closeImportSheet() {
  current = null;
  emit();
}

export function useImportSheetRequest(): SheetRequest {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
