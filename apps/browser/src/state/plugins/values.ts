import { rowValue, storedRows, type RowValue } from "../../lib/pluginManifest";
import { currentPlugins, recordOf, type PluginsStore } from "./store";

export function valuesOf(s: Pick<PluginsStore, "listings" | "records">, name: string): Record<string, RowValue> {
  const manifest = s.listings[name]?.manifest;
  if (!manifest) return {};
  const record = recordOf(s, name);
  return Object.fromEntries(storedRows(manifest.settings).map((row) => [row.key, rowValue(row, record.values[row.key])]));
}

export const valuesFor = (name: string) => valuesOf(currentPlugins(), name);
