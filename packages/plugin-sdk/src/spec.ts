export type JsonSchema = { [key: string]: unknown };

export const INVALID: unique symbol = Symbol("invalid");

export type Checked<T> = T | typeof INVALID;

export type Spec<T> = {
  readonly output?: T;
  readonly hasDefault?: boolean;
  readonly defaultValue?: unknown;
  accepts(value: unknown): boolean;
  check(value: unknown, path: string, problems: string[]): Checked<T>;
  schema(): JsonSchema;
};

export type Infer<S> = S extends { readonly output?: infer T } ? T : never;

type Flatten<T> = { [K in keyof T]: T[K] } & {};

type Defaulted<P> = { [K in keyof P]: P[K] extends { readonly hasDefault: true } ? K : never }[keyof P];

export type ObjectOf<P extends Record<string, Spec<unknown>>, R extends keyof P> = Flatten<
  { [K in R | Defaulted<P>]: Infer<P[K]> } & { [K in Exclude<keyof P, R | Defaulted<P>>]?: Infer<P[K]> }
>;

export const at = (path: string, key: string | number): string => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

const label = (path: string): string => path || "the manifest";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const withDescription = (schema: JsonSchema, description?: string): JsonSchema => (description ? { ...schema, description } : schema);

const UNSAFE_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069";
const UNSAFE_TEXT = new RegExp(`[${UNSAFE_CLASS}]`);

export type StringOptions = { pattern?: string; test?: (value: string) => boolean; rule: string; min?: number; max?: number; description?: string; format?: string };

export function str(options: StringOptions): Spec<string> {
  const pattern = options.pattern ? new RegExp(options.pattern) : null;
  return {
    accepts: (value) => typeof value === "string",
    check(value, path, problems) {
      const ok =
        typeof value === "string" &&
        value.length >= (options.min ?? 0) &&
        value.length <= (options.max ?? Infinity) &&
        (!pattern || pattern.test(value)) &&
        (!options.test || options.test(value));
      if (ok) return value;
      problems.push(`${label(path)} must be ${options.rule}`);
      return INVALID;
    },
    schema: () =>
      withDescription(
        {
          type: "string",
          ...(options.pattern ? { pattern: options.pattern } : {}),
          ...(options.min !== undefined ? { minLength: options.min } : {}),
          ...(options.max !== undefined ? { maxLength: options.max } : {}),
          ...(options.format ? { format: options.format } : {}),
        },
        options.description,
      ),
  };
}

export function freeText(max: number, description?: string): Spec<string> {
  return {
    accepts: (value) => typeof value === "string",
    check(value, path, problems) {
      if (typeof value !== "string" || value.length > max) {
        problems.push(`${label(path)} must be text of at most ${max} characters`);
        return INVALID;
      }
      if (UNSAFE_TEXT.test(value)) {
        problems.push(`${label(path)} has control or direction characters`);
        return INVALID;
      }
      return value;
    },
    schema: () => withDescription({ type: "string", pattern: `^[^${UNSAFE_CLASS}]{0,${max}}$` }, description),
  };
}

export function text(max: number, description?: string): Spec<string> {
  return {
    accepts: (value) => typeof value === "string",
    check(value, path, problems) {
      if (typeof value !== "string" || !value.trim() || value.length > max) {
        problems.push(`${label(path)} must be text of 1 to ${max} characters`);
        return INVALID;
      }
      if (UNSAFE_TEXT.test(value)) {
        problems.push(`${label(path)} has control or direction characters`);
        return INVALID;
      }
      return value;
    },
    schema: () => withDescription({ type: "string", pattern: `^(?=[\\s\\S]*\\S)[^${UNSAFE_CLASS}]{1,${max}}$` }, description),
  };
}

const show = (value: unknown): string => (typeof value === "string" ? `"${value}"` : String(value));

export function oneOf<const V extends readonly (string | number | boolean)[]>(values: V, description?: string): Spec<V[number]> {
  return {
    accepts: (value) => values.includes(value as V[number]),
    check(value, path, problems) {
      if (values.includes(value as V[number])) return value as V[number];
      problems.push(`${label(path)} must be ${values.length === 1 ? show(values[0]) : `one of ${values.map(show).join(", ")}`}`);
      return INVALID;
    },
    schema: () => withDescription(values.length === 1 ? { const: values[0] } : { enum: [...values] }, description),
  };
}

export function bool(description?: string): Spec<boolean> {
  return {
    accepts: (value) => typeof value === "boolean",
    check(value, path, problems) {
      if (typeof value === "boolean") return value;
      problems.push(`${label(path)} must be true or false`);
      return INVALID;
    },
    schema: () => withDescription({ type: "boolean" }, description),
  };
}

export function int(min: number, max: number, description?: string): Spec<number> {
  return {
    accepts: (value) => typeof value === "number",
    check(value, path, problems) {
      if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
      problems.push(`${label(path)} must be a whole number from ${min} to ${max}`);
      return INVALID;
    },
    schema: () => withDescription({ type: "integer", minimum: min, maximum: max }, description),
  };
}

export type NumberOptions = { min?: number; max?: number; exclusiveMinimum?: number; description?: string };

export function num(options: NumberOptions = {}): Spec<number> {
  const rule = options.exclusiveMinimum !== undefined ? `a number above ${options.exclusiveMinimum}` : "a number";
  return {
    accepts: (value) => typeof value === "number",
    check(value, path, problems) {
      const ok =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (options.min === undefined || value >= options.min) &&
        (options.max === undefined || value <= options.max) &&
        (options.exclusiveMinimum === undefined || value > options.exclusiveMinimum);
      if (ok) return value;
      problems.push(`${label(path)} must be ${rule}`);
      return INVALID;
    },
    schema: () =>
      withDescription(
        {
          type: "number",
          ...(options.min !== undefined ? { minimum: options.min } : {}),
          ...(options.max !== undefined ? { maximum: options.max } : {}),
          ...(options.exclusiveMinimum !== undefined ? { exclusiveMinimum: options.exclusiveMinimum } : {}),
        },
        options.description,
      ),
  };
}

export function json(description?: string): Spec<Record<string, unknown>> {
  return {
    accepts: isPlainObject,
    check(value, path, problems) {
      if (isPlainObject(value)) return value;
      problems.push(`${label(path)} must be an object`);
      return INVALID;
    },
    schema: () => withDescription({ type: "object" }, description),
  };
}

export type ArrayOptions = { min?: number; max: number; unique?: boolean; description?: string };

export function arr<T>(item: Spec<T>, options: ArrayOptions): Spec<T[]> {
  const min = options.min ?? 0;
  return {
    accepts: Array.isArray,
    check(value, path, problems) {
      if (!Array.isArray(value) || value.length < min || value.length > options.max) {
        problems.push(`${label(path)} must be a list of ${min ? `${min} to ${options.max}` : `at most ${options.max}`}`);
        return INVALID;
      }
      const out: T[] = [];
      let failed = false;
      value.forEach((entry, i) => {
        const checked = item.check(entry, at(path, i), problems);
        if (checked === INVALID) failed = true;
        else out.push(checked);
      });
      if (options.unique) {
        const seen = new Set<string>();
        for (const entry of out) {
          const k = JSON.stringify(entry);
          if (seen.has(k)) {
            problems.push(`${label(path)} lists ${k} twice`);
            failed = true;
          }
          seen.add(k);
        }
      }
      return failed ? INVALID : out;
    },
    schema: () =>
      withDescription(
        { type: "array", items: item.schema(), ...(min ? { minItems: min } : {}), maxItems: options.max, ...(options.unique ? { uniqueItems: true } : {}) },
        options.description,
      ),
  };
}

export type ObjectOptions<R> = { required?: readonly R[]; description?: string; schemaExtra?: JsonSchema; what?: string };

export function obj<P extends Record<string, Spec<any>>, R extends keyof P & string = never>(props: P, options: ObjectOptions<R> = {}): Spec<ObjectOf<P, R>> {
  const required = new Set<string>(options.required ?? []);
  return {
    accepts: isPlainObject,
    check(value, path, problems) {
      if (!isPlainObject(value)) {
        problems.push(`${path || options.what || label(path)} must be an object`);
        return INVALID;
      }
      const out: Record<string, unknown> = {};
      let failed = false;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) {
          problems.push(`${at(path, key)} isn't a key of ${path || options.what || "a plugin manifest"}`);
          failed = true;
        }
      }
      for (const [key, spec] of Object.entries(props)) {
        const given = value[key];
        if (given === undefined) {
          if (required.has(key)) {
            problems.push(`${at(path, key)} is required`);
            failed = true;
          } else if (spec.hasDefault) out[key] = structuredCopy(spec.defaultValue);
          continue;
        }
        const checked = spec.check(given, at(path, key), problems);
        if (checked === INVALID) failed = true;
        else out[key] = checked;
      }
      return failed ? INVALID : (out as ObjectOf<P, R>);
    },
    schema: () => {
      const properties = Object.fromEntries(Object.entries(props).map(([key, spec]) => [key, spec.schema()]));
      const base: JsonSchema = { type: "object", properties, additionalProperties: false, ...(required.size ? { required: [...required] } : {}) };
      return withDescription({ ...base, ...(options.schemaExtra ?? {}) }, options.description);
    },
  };
}

function structuredCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export type RecordOptions = { keyPattern: string; keyRule: string; max: number; description?: string };

export function record<T>(value: Spec<T>, options: RecordOptions): Spec<Record<string, T>> {
  const keyPattern = new RegExp(options.keyPattern);
  return {
    accepts: isPlainObject,
    check(input, path, problems) {
      if (!isPlainObject(input)) {
        problems.push(`${label(path)} must be an object`);
        return INVALID;
      }
      const keys = Object.keys(input);
      if (keys.length > options.max) {
        problems.push(`${label(path)} must have at most ${options.max} entries`);
        return INVALID;
      }
      const out: Record<string, T> = {};
      let failed = false;
      for (const key of keys) {
        if (!keyPattern.test(key)) {
          problems.push(`${at(path, key)}: ${key} must be ${options.keyRule}`);
          failed = true;
          continue;
        }
        const checked = value.check(input[key], at(path, key), problems);
        if (checked === INVALID) failed = true;
        else out[key] = checked;
      }
      return failed ? INVALID : out;
    },
    schema: () =>
      withDescription(
        { type: "object", propertyNames: { pattern: options.keyPattern }, additionalProperties: value.schema(), maxProperties: options.max },
        options.description,
      ),
  };
}

export function union<S extends readonly Spec<any>[]>(alternatives: S, rule: string, description?: string): Spec<Infer<S[number]>> {
  return {
    accepts: (value) => alternatives.some((a) => a.accepts(value)),
    check(value, path, problems) {
      const shaped = alternatives.filter((a) => a.accepts(value));
      if (shaped.length === 1) return (shaped[0] as Spec<Infer<S[number]>>).check(value, path, problems);
      for (const alternative of shaped) {
        const quiet: string[] = [];
        const checked = alternative.check(value, path, quiet);
        if (checked !== INVALID && quiet.length === 0) return checked;
      }
      problems.push(`${label(path)} must be ${rule}`);
      return INVALID;
    },
    schema: () => withDescription({ anyOf: alternatives.map((a) => a.schema()) }, description),
  };
}

export function nullable<T>(spec: Spec<T>): Spec<T | null> {
  return {
    accepts: (value) => value === null || spec.accepts(value),
    check: (value, path, problems) => (value === null ? null : spec.check(value, path, problems)),
    schema: () => ({ anyOf: [{ type: "null" }, spec.schema()] }),
  };
}

export function withDefault<T>(spec: Spec<T>, value: T): Spec<T> & { readonly hasDefault: true } {
  return {
    ...spec,
    hasDefault: true,
    defaultValue: value,
    schema: () => ({ ...spec.schema(), default: value }),
  };
}

export function described<T>(spec: Spec<T>, description: string): Spec<T> {
  return { ...spec, schema: () => ({ ...spec.schema(), description }) };
}

export function validate<T>(spec: Spec<T>, value: unknown): { ok: true; value: T } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const checked = spec.check(value, "", problems);
  if (checked === INVALID || problems.length) return { ok: false, problems: problems.length ? problems : ["The value isn't valid"] };
  return { ok: true, value: checked };
}
