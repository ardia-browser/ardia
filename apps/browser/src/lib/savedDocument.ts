import { isFields, type Fields } from "./decode";

export type SavedObject = Fields;
export type Migrations = Readonly<Record<number, (doc: SavedObject) => unknown>>;

export const unchanged = (doc: SavedObject): SavedObject => doc;

const owns = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);

export function upgraded(doc: unknown, version: number, migrations: Migrations = {}, field = "version"): SavedObject | null {
  if (!isFields(doc)) return null;
  let at = 0;
  if (owns(doc, field)) {
    const saved = doc[field];
    if (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0) return null;
    at = saved;
  }
  if (at > version) return null;
  let current = doc;
  while (at < version) {
    if (!owns(migrations, at)) return null;
    const next = migrations[at]!(current);
    if (!isFields(next)) return null;
    at += 1;
    current = { ...next, [field]: at };
  }
  return current;
}

export type SavedProblem = "empty" | "invalid" | "shape" | "newer";
type SavedRead = { doc: SavedObject; from: number } | { problem: SavedProblem };

export function readSavedValue(value: unknown, version: number, migrations: Migrations = {}, field = "version"): SavedRead {
  const stamped = isFields(value) && owns(value, field) ? value[field] : 0;
  if (typeof stamped === "number" && Number.isSafeInteger(stamped) && stamped > version) return { problem: "newer" };
  let doc: SavedObject | null = null;
  try {
    doc = upgraded(value, version, migrations, field);
  } catch {
    doc = null;
  }
  return doc && typeof stamped === "number" ? { doc, from: stamped } : { problem: "shape" };
}

export function readSaved(json: string, version: number, migrations: Migrations = {}, field = "version"): SavedRead {
  if (!json.trim()) return { problem: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { problem: "invalid" };
  }
  return readSavedValue(value, version, migrations, field);
}

export function parseSaved(json: string | null | undefined, version: number, migrations: Migrations = {}, field = "version"): SavedObject | null {
  if (!json) return null;
  try {
    return upgraded(JSON.parse(json), version, migrations, field);
  } catch {
    return null;
  }
}

export const versionedJson = (data: object, version: number, field = "version", space?: number): string =>
  JSON.stringify({ ...data, [field]: version }, null, space);
