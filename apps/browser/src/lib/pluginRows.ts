import type { Fields } from "./decode";
import { at, KEY, KEY_RULE, LIMITS, list, matching, object, only, text, UNSAFE_TEXT, unique, type Check } from "./pluginChecks";

export const ROW_TYPES = ["toggle", "text", "number", "choice", "secret"] as const;
export type RowType = (typeof ROW_TYPES)[number];
export type RowValue = string | boolean | number;

type RowBase = { key: string; title: string; description?: string };
export type RowSpec =
  | (RowBase & { type: "toggle"; default: boolean })
  | (RowBase & { type: "text"; default: string })
  | (RowBase & { type: "number"; default: number; min?: number; max?: number; step?: number })
  | (RowBase & { type: "choice"; default: string; choices: { value: string; title: string }[] })
  | (RowBase & { type: "secret"; default: ""; placeholder?: string });

export type SettingsSpec = { defaults: Fields; rows: RowSpec[] };

const ROW_KEYS = ["key", "title", "description", "type", "default", "choices", "min", "max", "step", "placeholder"];
const NUMBER_LIMIT = 1e12;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= NUMBER_LIMIT;

function optionalNumber(c: Check, path: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (isNumber(value)) return value;
  c.problems.push(`${path} must be a number`);
  return undefined;
}

function numberRow(c: Check, path: string, doc: Fields, base: RowBase): RowSpec | null {
  const min = optionalNumber(c, `${path}.min`, doc.min);
  const max = optionalNumber(c, `${path}.max`, doc.max);
  const step = optionalNumber(c, `${path}.step`, doc.step);
  if (step !== undefined && step <= 0) return void c.problems.push(`${path}.step must be above 0`), null;
  if (min !== undefined && max !== undefined && min > max) return void c.problems.push(`${path}.min must be at most its max`), null;
  if (!isNumber(doc.default) || (min !== undefined && doc.default < min) || (max !== undefined && doc.default > max))
    return void c.problems.push(`${path}.default must be a number between its min and max`), null;
  return { ...base, type: "number", default: doc.default, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}) };
}

function choiceRow(c: Check, path: string, doc: Fields, base: RowBase): RowSpec | null {
  const [least, most] = LIMITS.choices;
  if (!Array.isArray(doc.choices) || doc.choices.length < least || doc.choices.length > most) {
    c.problems.push(`${path}.choices must be a list of ${least} to ${most} choices`);
    return null;
  }
  const choices = doc.choices.flatMap((choice, i) => {
    const p = at(`${path}.choices`, i);
    const fields = object(c, p, choice);
    if (!fields) return [];
    only(c, p, fields, ["value", "title"]);
    const v = matching(c, `${p}.value`, fields.value, KEY, KEY_RULE);
    const t = text(c, `${p}.title`, fields.title, LIMITS.title);
    return v && t ? [{ value: v, title: t }] : [];
  });
  unique(c, `${path}.choices`, choices.map((x) => x.value), "choices");
  if (!choices.some((x) => x.value === doc.default)) return void c.problems.push(`${path}.default must be one of its choices' values`), null;
  return { ...base, type: "choice", default: doc.default as string, choices };
}

function misplaced(c: Check, path: string, doc: Fields, type: RowType) {
  const belongs: Record<string, RowType[]> = { choices: ["choice"], min: ["number"], max: ["number"], step: ["number"], placeholder: ["secret", "text"] };
  for (const [key, types] of Object.entries(belongs)) if (doc[key] !== undefined && !types.includes(type)) c.problems.push(`${path}.${key} only goes with type ${types.join(" or ")}`);
}

export function row(c: Check, path: string, value: unknown): RowSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ROW_KEYS);
  const key = matching(c, `${path}.key`, doc.key, KEY, KEY_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const description = text(c, `${path}.description`, doc.description, LIMITS.description, false) ?? undefined;
  const type = doc.type as RowType;
  if (!(ROW_TYPES as readonly unknown[]).includes(type)) {
    c.problems.push(`${path}.type must be toggle, text, number, choice or secret`);
    return null;
  }
  misplaced(c, path, doc, type);
  if (!key || !title) return null;
  const base: RowBase = { key, title, ...(description ? { description } : {}) };
  if (type === "toggle") {
    if (typeof doc.default !== "boolean") return void c.problems.push(`${path}.default must be true or false`), null;
    return { ...base, type, default: doc.default };
  }
  if (type === "text") {
    if (typeof doc.default !== "string" || doc.default.length > LIMITS.rowText || UNSAFE_TEXT.test(doc.default))
      return void c.problems.push(`${path}.default must be text of at most ${LIMITS.rowText} characters`), null;
    return { ...base, type, default: doc.default };
  }
  if (type === "number") return numberRow(c, path, doc, base);
  if (type === "secret") {
    if (doc.default !== undefined) c.problems.push(`${path}.default can't go with a secret: it's kept in the Keychain, never in plugin.json`);
    const placeholder = text(c, `${path}.placeholder`, doc.placeholder, LIMITS.title, false);
    return { ...base, type, default: "", ...(placeholder ? { placeholder } : {}) };
  }
  return choiceRow(c, path, doc, base);
}

export function settingsOf(c: Check, path: string, value: unknown): SettingsSpec {
  if (value === undefined) return { defaults: {}, rows: [] };
  const doc = object(c, path, value);
  if (!doc) return { defaults: {}, rows: [] };
  only(c, path, doc, ["defaults", "rows"]);
  const defaults = doc.defaults === undefined ? {} : (object(c, `${path}.defaults`, doc.defaults) ?? {});
  const rows = list(c, `${path}.rows`, doc.rows, LIMITS.rows).flatMap((r, i) => row(c, at(`${path}.rows`, i), r) ?? []);
  unique(c, `${path}.rows`, rows.map((r) => r.key), "rows");
  return { defaults, rows };
}

export const storedRows = (settings: SettingsSpec) => settings.rows.filter((r) => r.type !== "secret");

export const secretRows = (settings: SettingsSpec) => settings.rows.filter((r) => r.type === "secret");

export function rowValue(r: RowSpec, value: unknown): RowValue {
  if (r.type === "toggle") return typeof value === "boolean" ? value : r.default;
  if (r.type === "text") return typeof value === "string" && value.length <= LIMITS.rowText && !UNSAFE_TEXT.test(value) ? value : r.default;
  if (r.type === "secret") return "";
  if (r.type === "number") return isNumber(value) && (r.min === undefined || value >= r.min) && (r.max === undefined || value <= r.max) ? value : r.default;
  return typeof value === "string" && r.choices.some((x) => x.value === value) ? value : r.default;
}
