export type Fields = Record<string, unknown>;

export const P = "contributes.credentialProvider";
export const KEY = /^[A-Za-z0-9_-]{1,40}$/;
export const KEY_RULE = "1 to 40 letters, digits, - and _";
export const SYMBOL = /^[a-z0-9.]{1,64}$/;
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

export class Checks {
  readonly problems: string[] = [];

  add(problem: string) {
    this.problems.push(problem);
  }

  only(path: string, doc: Fields, keys: readonly string[], of = `of ${path}`) {
    for (const key of Object.keys(doc)) if (!keys.includes(key)) this.add(`${path}.${key} isn't a key ${of}`);
  }

  object(path: string, value: unknown): Fields | null {
    if (isFields(value)) return value;
    this.add(`${path} must be an object`);
    return null;
  }

  text(path: string, value: unknown, max: number, required = true): string | null {
    if (value === undefined && !required) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      this.add(`${path} must be text of 1 to ${max} characters`);
      return null;
    }
    if (UNSAFE_TEXT.test(value)) {
      this.add(`${path} has control or direction characters`);
      return null;
    }
    return value;
  }

  plain(path: string, value: unknown, max: number, rule: string): string | null {
    if (typeof value === "string" && value.length <= max && !CONTROL.test(value)) return value;
    this.add(`${path} ${rule}`);
    return null;
  }

  matching(path: string, value: unknown, pattern: RegExp, rule: string, required = true): string | null {
    if (value === undefined && !required) return null;
    if (typeof value === "string" && pattern.test(value)) return value;
    this.add(`${path} must be ${rule}`);
    return null;
  }

  flag(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.add(`${path} must be true or false`);
    return fallback;
  }

  integer(path: string, value: unknown, min: number, max: number, fallback: number): number;
  integer(path: string, value: unknown, min: number, max: number, fallback: null): number | null;
  integer(path: string, value: unknown, min: number, max: number, fallback: number | null): number | null {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
    this.add(`${path} must be a whole number from ${min} to ${max}`);
    return fallback;
  }

  list(path: string, value: unknown, least: number, most: number): unknown[] | null {
    if (value === undefined && least === 0) return [];
    if (Array.isArray(value) && value.length >= least && value.length <= most) return value;
    this.add(least > 0 ? `${path} must be a list of ${least} to ${most}` : `${path} must be a list of at most ${most}`);
    return null;
  }
}

export function isPluginFile(value: string): boolean {
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
