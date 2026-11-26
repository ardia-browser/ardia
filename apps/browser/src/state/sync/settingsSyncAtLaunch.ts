import { readDocument } from "../../platform/documents";
import { SyncNative } from "../../platform/sync";
import { parseSaved } from "../../lib/savedDocument";
import { DOC, DOC_MIGRATIONS, DOC_VERSION, defaultTypes, typeSyncedFor, type SyncDoc } from "./syncDoc";

export function settingsSyncWaitsAtLaunch(): boolean {
  if (!SyncNative) return false;
  try {
    const saved = parseSaved(readDocument(DOC), DOC_VERSION, DOC_MIGRATIONS, "v") as Partial<SyncDoc> | null;
    return !!saved?.enabled && !!saved.deviceId && typeSyncedFor({ ...defaultTypes(), ...saved.types }, "settings", true);
  } catch {
    return false;
  }
}
