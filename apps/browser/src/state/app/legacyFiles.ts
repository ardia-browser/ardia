import { readDocument, removeDocument } from "../../platform/documents";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export async function migrateLegacyFile<T>(name: string, area: string, move: (file: T) => Promise<void>, keepMs: number): Promise<"none" | "moved" | "kept"> {
  const consent = consentToken();
  let file: T | null;
  try {
    const json = readDocument(name);
    file = json ? (JSON.parse(json) as T) : null;
  } catch (error) {
    console.warn(`[${area}] ${name} is unreadable; leaving it`, error);
    return "kept";
  }
  if (!file) return "none";
  try {
    await move(file);
  } catch (error) {
    warnFor(consent, `[${area}] moving ${name} into Chrome failed; trying again next launch`, error);
    return "kept";
  }
  if (keepMs) setTimeout(() => removeDocument(name), keepMs);
  else removeDocument(name);
  return "moved";
}
