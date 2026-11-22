import type { JsonSchema, JsonType } from "../../lib/jsonSchema";
import { t } from "../../lib/uiLanguage";


const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(value: unknown): JsonType | null {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isFinite(value) ? (Number.isInteger(value) ? "integer" : "number") : null;
  return typeof value as JsonType;
}

export const ownField = <T>(fields: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (fields && Object.hasOwn(fields, key) ? fields[key] : undefined);

const fits = (value: unknown, type: JsonType) => {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer" && Number.isSafeInteger(value);
  return actual === type;
};

const words = (types: JsonType[]) => types.map((t) => (t === "integer" ? t(`a whole number`) : t === "null" ? "null" : t === "array" ? t(`a list`) : t === "object" ? t(`an object`) : `a ${t}`)).join(t(` or `));

export function schemaProblem(schema: JsonSchema, value: unknown, path: string): string | null {
  if (schema.anyOf) return schema.anyOf.some((option) => schemaProblem(option, value, path) === null) ? null : `${path} doesn't match any of its forms.`;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (typeof value === "number" && !Number.isFinite(value)) return `${path} must be a finite number.`;
  if (types.length && !types.some((t) => fits(value, t))) return `${path} must be ${words(types)}.`;
  if (schema.const !== undefined && value !== schema.const) return `${path} must be ${JSON.stringify(schema.const)}.`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.map(String).join(", ")}.`;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${path} must be above ${schema.exclusiveMinimum}.`;
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} doesn't have the right form.`;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items.`;
    if (schema.prefixItems) {
      for (const [i, item] of schema.prefixItems.entries()) {
        const problem = schemaProblem(item, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
    }
    if (typeof schema.items === "object") {
      for (const [i, item] of value.entries()) {
        const problem = schemaProblem(schema.items, item, `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (isFields(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (ownField(value, key) === undefined) return `${path === "params" ? "" : `${path}: `}${key} is required.`.replace(/^./, (c) => c.toUpperCase());
    for (const [key, item] of Object.entries(value)) {
      const known = ownField(properties, key);
      const where = path === "params" ? key : `${path}.${key}`;
      if (known) {
        const problem = schemaProblem(known, item, where);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        const takes = Object.keys(properties);
        return `${path === "params" ? "This method" : path} takes no ${key}${takes.length ? ` (it takes ${takes.join(", ")})` : ""}.`;
      } else if (typeof schema.additionalProperties === "object") {
        const problem = schemaProblem(schema.additionalProperties, item, where);
        if (problem) return problem;
      }
    }
  }
  return null;
}

export const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

export const id = (description: string): JsonSchema => ({ type: "string", description });
export const ids = (description: string, max = 500): JsonSchema => ({ type: "array", items: { type: "string" }, minItems: 1, maxItems: max, description });
export const bool = (description: string): JsonSchema => ({ type: "boolean", description });
export const text = (description: string): JsonSchema => ({ type: "string", description });
export const int = (description: string, minimum?: number, maximum?: number): JsonSchema => ({ type: "integer", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
export const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: values, description });

export const WINDOW = id(t(`A window id from windows`));
export const TAB = id(t(`A tab id from windows or tabs.list`));
export const PROFILE = id(t(`A profile id from profiles.list; the default profile when left out`));
export const NO_PARAMS = obj({});
export const PAGE = { limit: int(t(`At most this many items (default 100)`), 1, 1000), offset: int(t(`Skip this many items first (default 0)`), 0) };
