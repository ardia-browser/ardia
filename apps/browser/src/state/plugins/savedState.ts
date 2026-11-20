import { documentSaved, readDocument, writeDocument } from "../../platform/documents";
import { isFields, type Fields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { NAME_PATTERN } from "../../lib/pluginManifest";
import type { PluginRecord } from "./store";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";

export const PLUGINS_DOC = "plugins.json";
const VERSION = 1;
const NAME = new RegExp(NAME_PATTERN);

const HASH = /^[0-9a-f]{64}$/;

function valuesOf(raw: unknown): Record<string, string | boolean> {
  if (!isFields(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string | boolean] => typeof e[1] === "string" || typeof e[1] === "boolean"));
}

function appliedOf(raw: unknown): PluginRecord["applied"] {
  if (!isFields(raw)) return {};
  const out: PluginRecord["applied"] = {};
  for (const [key, entry] of Object.entries(raw)) if (isFields(entry) && Object.hasOwn(entry, "value")) out[key] = { value: entry.value, previous: entry.previous, order: typeof entry.order === "number" && Number.isSafeInteger(entry.order) ? entry.order : 0, over: typeof entry.over === "string" && NAME.test(entry.over) ? entry.over : null };
  return out;
}

export function parsePluginRecords(json: string | null): Record<string, PluginRecord> {
  const doc = parseSaved(json, VERSION);
  if (!doc || !isFields(doc.plugins)) return {};
  const out: Record<string, PluginRecord> = {};
  for (const [name, raw] of Object.entries(doc.plugins as Fields)) {
    if (!NAME.test(name) || !isFields(raw)) continue;
    const approved = typeof raw.approved === "string" && HASH.test(raw.approved) ? raw.approved : null;
    out[name] = { enabled: raw.enabled === true && approved !== null, approved, values: valuesOf(raw.values), applied: appliedOf(raw.applied), ...(raw.controlGranted === true ? { controlGranted: true } : {}), ...(raw.installed === true ? { installed: true } : {}) };
  }
  return out;
}

export const pluginRecordsJson = (records: Record<string, PluginRecord>) => versionedJson({ plugins: records }, VERSION);

export function readPluginRecords(): Record<string, PluginRecord> {
  try {
    return parsePluginRecords(readDocument(PLUGINS_DOC));
  } catch {
    return {};
  }
}

export function writePluginRecords(records: Record<string, PluginRecord>, consent: ConsentToken | null): boolean {
  try {
    writeDocument(PLUGINS_DOC, pluginRecordsJson(records));
    return true;
  } catch (error) {
    warnFor(consent, "[plugins] couldn't save plugins.json", error);
    return false;
  }
}

export const pluginRecordsSaved = (consent: ConsentToken | null): Promise<boolean> =>
  documentSaved(PLUGINS_DOC).then(
    () => true,
    (error: unknown) => {
      warnFor(consent, "[plugins] couldn't save plugins.json", error);
      return false;
    },
  );
