export class ToolError extends Error {}

export type Spec =
  | { t: "string"; max?: number; min?: number; pattern?: RegExp; what?: string; enum?: readonly string[] }
  | { t: "number"; min?: number; max?: number; int?: boolean }
  | { t: "boolean" }
  | { t: "array"; of: Spec; max?: number; min?: number }
  | { t: "object"; fields: Record<string, Field> }
  | { t: "record"; of: Spec; max?: number; key?: string }
  | { t: "any"; what: string; maxBytes?: number }
  | { t: "oneOf"; of: Spec[]; what?: string }
  | { t: "null" };

export type Field = { spec: Spec; required?: boolean; doc?: string };

export const str = (max = 2000, extra: Partial<Extract<Spec, { t: "string" }>> = {}): Spec => ({ t: "string", max, ...extra });
export const id12: Spec = { t: "string", pattern: /^[0-9a-f]{12}$/, what: "a 12-character hex page id" };
export const wsId: Spec = { t: "string", pattern: /^[0-9a-f]{12,32}$/, what: "a workspace id" };
export const oneOf = (values: readonly string[]): Spec => ({ t: "string", enum: values });
export const int = (min: number, max: number): Spec => ({ t: "number", min, max, int: true });
export const num = (min = -1e15, max = 1e15): Spec => ({ t: "number", min, max });
export const bool: Spec = { t: "boolean" };
export const arr = (of: Spec, max = 1000, min = 0): Spec => ({ t: "array", of, max, min });
export const obj = (fields: Record<string, Field>): Spec => ({ t: "object", fields });
export const rec = (of: Spec, max = 500, key = "key"): Spec => ({ t: "record", of, max, key });
export const any = (what: string, maxBytes = 1_000_000): Spec => ({ t: "any", what, maxBytes });
export const either = (of: Spec[], what?: string): Spec => ({ t: "oneOf", of, ...(what ? { what } : {}) });
export const nul: Spec = { t: "null" };
export const req = (spec: Spec, doc?: string): Field => ({ spec, required: true, ...(doc ? { doc } : {}) });
export const opt = (spec: Spec, doc?: string): Field => ({ spec, ...(doc ? { doc } : {}) });

function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[y.length]!;
}

export function closest(word: string, options: Iterable<string>): string | null {
  let best: string | null = null;
  let score = Infinity;
  const lower = word.toLowerCase();
  for (const option of options) {
    const o = option.toLowerCase();
    const d = o === lower ? 0 : o.startsWith(lower) || lower.startsWith(o) ? 1 : distance(word, option);
    if (d < score) {
      score = d;
      best = option;
    }
  }
  if (best === null) return null;
  return score <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

export const suggest = (word: string, options: Iterable<string>) => {
  const hit = closest(word, options);
  return hit ? `; did you mean '${hit}'?` : "";
};

export const quoteList = (values: readonly string[], max = 30) => values.slice(0, max).map((v) => `'${v}'`).join(", ") + (values.length > max ? ", …" : "");

function describeSpec(spec: Spec): string {
  switch (spec.t) {
    case "string":
      if (spec.enum) return `one of ${quoteList(spec.enum)}`;
      return spec.what ?? `text of at most ${spec.max ?? 2000} characters`;
    case "number":
      return spec.int ? `a whole number from ${spec.min} to ${spec.max}` : `a number from ${spec.min} to ${spec.max}`;
    case "boolean":
      return "true or false";
    case "array":
      return `a list of at most ${spec.max ?? 1000} items`;
    case "object":
      return "an object";
    case "record":
      return "an object";
    case "any":
      return spec.what;
    case "oneOf":
      return spec.what ?? spec.of.map(describeSpec).join(", or ");
    case "null":
      return "null";
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function check(spec: Spec, value: unknown, path: string): unknown {
  const fail = (): never => {
    throw new ToolError(`${path} must be ${describeSpec(spec)}${value === undefined ? "" : `, not ${preview(value)}`}.`);
  };
  switch (spec.t) {
    case "string": {
      if (typeof value !== "string") return fail();
      if (spec.enum) {
        if (spec.enum.includes(value)) return value;
        throw new ToolError(`${path} is '${value.slice(0, 60)}', which isn't one of ${quoteList(spec.enum)}${suggest(value, spec.enum)}`);
      }
      if (spec.max !== undefined && value.length > spec.max) throw new ToolError(`${path} is ${value.length} characters; the most is ${spec.max}.`);
      if (spec.min !== undefined && value.length < spec.min) return fail();
      if (spec.pattern && !spec.pattern.test(value)) return fail();
      return value;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail();
      if (spec.int && !Number.isInteger(value)) return fail();
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) return fail();
      return value;
    case "boolean":
      return typeof value === "boolean" ? value : fail();
    case "null":
      return value === null ? null : fail();
    case "array": {
      if (!Array.isArray(value)) return fail();
      if (spec.max !== undefined && value.length > spec.max) throw new ToolError(`${path} has ${value.length} items; the most is ${spec.max}.`);
      if (spec.min !== undefined && value.length < spec.min) throw new ToolError(`${path} needs at least ${spec.min} item${spec.min === 1 ? "" : "s"}.`);
      return value.map((item, i) => check(spec.of, item, `${path}[${i}]`));
    }
    case "record": {
      if (!isPlain(value)) return fail();
      const keys = Object.keys(value);
      if (spec.max !== undefined && keys.length > spec.max) throw new ToolError(`${path} has ${keys.length} entries; the most is ${spec.max}.`);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k.length > 200) throw new ToolError(`${path} has a ${spec.key ?? "key"} longer than 200 characters.`);
        out[k] = check(spec.of, value[k], `${path}.${k}`);
      }
      return out;
    }
    case "object":
      return checkFields(spec.fields, value, path);
    case "any": {
      if (spec.maxBytes !== undefined) {
        let size = 0;
        try {
          size = JSON.stringify(value ?? null).length;
        } catch {
          return fail();
        }
        if (size > spec.maxBytes) throw new ToolError(`${path} is ${size} bytes; the most is ${spec.maxBytes}.`);
      }
      return value;
    }
    case "oneOf": {
      const errors: string[] = [];
      for (const option of spec.of) {
        try {
          return check(option, value, path);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (spec.of.length === 1) throw new ToolError(errors[0]!);
      const typed = spec.of.filter((o) => sameKind(o, value));
      if (typed.length === 1) return check(typed[0]!, value, path);
      return fail();
    }
  }
}

function sameKind(spec: Spec, value: unknown): boolean {
  if (spec.t === "string") return typeof value === "string";
  if (spec.t === "number") return typeof value === "number";
  if (spec.t === "boolean") return typeof value === "boolean";
  if (spec.t === "array") return Array.isArray(value);
  if (spec.t === "object" || spec.t === "record") return isPlain(value);
  if (spec.t === "null") return value === null;
  return false;
}

export function checkFields(fields: Record<string, Field>, value: unknown, path: string): Record<string, unknown> {
  const given = value === undefined || value === null ? {} : value;
  if (!isPlain(given)) throw new ToolError(`${path} must be an object, not ${preview(value)}.`);
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(fields, key)) {
      const known = Object.keys(fields);
      throw new ToolError(`unknown field '${key.slice(0, 60)}' in ${path}${suggest(key, known)}${known.length ? ` Fields here: ${quoteList(known)}.` : " It takes no fields."}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const v = given[key];
    if (v === undefined) {
      if (field.required) throw new ToolError(`${path}.${key} is required: ${field.doc ?? describeSpec(field.spec)}.`);
      continue;
    }
    out[key] = check(field.spec, v, `${path}.${key}`);
  }
  return out;
}

export function preview(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `'${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
  return String(value);
}

export function specJson(spec: Spec): Record<string, unknown> {
  switch (spec.t) {
    case "string":
      return { type: "string", ...(spec.enum ? { enum: [...spec.enum] } : {}), ...(spec.max !== undefined && !spec.enum ? { maxLength: spec.max } : {}), ...(spec.pattern ? { pattern: spec.pattern.source } : {}), ...(spec.what ? { description: spec.what } : {}) };
    case "number":
      return { type: spec.int ? "integer" : "number", minimum: spec.min, maximum: spec.max };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "array":
      return { type: "array", items: specJson(spec.of), ...(spec.max !== undefined ? { maxItems: spec.max } : {}) };
    case "record":
      return { type: "object", additionalProperties: specJson(spec.of) };
    case "object":
      return fieldsJson(spec.fields);
    case "any":
      return { description: spec.what };
    case "oneOf":
      return { anyOf: spec.of.map(specJson), ...(spec.what ? { description: spec.what } : {}) };
  }
}

export function fieldsJson(fields: Record<string, Field>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, f] of Object.entries(fields)) {
    properties[k] = { ...specJson(f.spec), ...(f.doc ? { description: f.doc } : {}) };
    if (f.required) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}
