import { isString } from "../../lib/decode";
import type { JsonSchema } from "../../lib/jsonSchema";

export type SettingSpec<T> = { default: T; valid: (value: unknown) => boolean; synced: boolean; schema: JsonSchema; values?: readonly T[] };

export const SYNCED = true;

export const STRING_LIST: JsonSchema = { type: "array", items: { type: "string" } };
export const WIDTH: JsonSchema = { type: "number", exclusiveMinimum: 0 };
export const isWidth = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

export const flag = (d: boolean, synced = false): SettingSpec<boolean> => ({ default: d, valid: (v) => typeof v === "boolean", synced, schema: { type: "boolean" } });
export const text = (d: string, synced = false): SettingSpec<string> => ({ default: d, valid: isString, synced, schema: { type: "string" } });
export const width = (d: number): SettingSpec<number> => ({ default: d, valid: isWidth, synced: false, schema: WIDTH });
export const fraction = (d: number, synced = false): SettingSpec<number> => ({ default: d, valid: (v) => typeof v === "number" && v >= 0 && v <= 1, synced, schema: { type: "number", minimum: 0, maximum: 1 } });
export const oneOf = <const V extends readonly string[]>(values: V, d: V[number], synced = false): SettingSpec<V[number]> & { values: V } => ({
  default: d,
  values,
  valid: (v) => values.includes(v as string),
  synced,
  schema: { type: "string", enum: values },
});
export const shaped = <T,>(d: T, valid: (v: unknown) => boolean, schema: JsonSchema, synced = false): SettingSpec<T> => ({ default: d, valid, synced, schema });
