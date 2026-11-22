import { isFields, type Fields } from "./decode";
import { isWellFormed } from "./pluginNames";
import { t } from "./uiLanguage";


export const LIMITS = {
  name: 40,
  title: 60,
  description: 200,
  pageTitle: 40,
  rows: 20,
  rowText: 200,
  choices: [2, 12],
  commands: 20,
  keywords: 8,
  keyword: 40,
  pluginKeywords: 12,
  example: 120,
  telemetryItems: 16,
  telemetryItem: 800,
  tools: 32,
  toolTimeout: [1, 300],
  argv: 32,
  argBytes: 1024,
  memoryMB: [64, 4096],
  programs: 4,
  afterUpdate: [4, 8],
  hooks: 64,
  menuItems: 8,
  toolbar: 4,
  sidebarViews: 4,
  panels: 8,
  omnibox: 4,
  themes: 8,
  activationEvents: 32,
  allowedHosts: 32,
  when: 200,
  tooltip: 120,
} as const;

export const DEFAULT_SIDECAR_MB = 1024;
export const DEFAULT_MAIN_MB = 256;

export const NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
export const KEY_PATTERN = "^[A-Za-z0-9_-]{1,40}$";
export const VERSION_PATTERN = "^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}(-[0-9A-Za-z.-]{1,40})?$";
export const SYMBOL_PATTERN = "^[a-z0-9.]{1,64}$";
export const KEYWORD_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$";
export const NAME = new RegExp(NAME_PATTERN);
export const KEY = new RegExp(KEY_PATTERN);
export const VERSION = new RegExp(VERSION_PATTERN);
export const SYMBOL = new RegExp(SYMBOL_PATTERN);
export const KEYWORD = new RegExp(KEYWORD_PATTERN);
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

export const NAME_RULE = t(`1 to 40 lowercase letters, digits and dashes, starting with a letter or digit`);
export const KEY_RULE = t(`1 to 40 letters, digits, - and _`);
export const SYMBOL_RULE = t(`an SF Symbol name`);

export type Check = { problems: string[] };

export const at = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

export function only(c: Check, path: string, doc: Fields, keys: readonly string[]) {
  for (const key of Object.keys(doc)) if (!keys.includes(key)) c.problems.push(`${at(path, key)} isn't a key ${path ? `of ${path}` : "of a plugin"}`);
}

export function text(c: Check, path: string, value: unknown, max: number, required = true): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    c.problems.push(`${path} must be text of 1 to ${max} characters`);
    return null;
  }
  if (UNSAFE_TEXT.test(value)) {
    c.problems.push(`${path} has control or direction characters`);
    return null;
  }
  return value;
}

export function matching(c: Check, path: string, value: unknown, pattern: RegExp, rule: string, required = true): string | null {
  if (value === undefined && !required) return null;
  if (typeof value === "string" && pattern.test(value)) return value;
  c.problems.push(`${path} must be ${rule}`);
  return null;
}

export function list(c: Check, path: string, value: unknown, max: number): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length <= max) return value;
  c.problems.push(`${path} must be a list of at most ${max}`);
  return [];
}

export function object(c: Check, path: string, value: unknown): Fields | null {
  if (isFields(value)) return value;
  c.problems.push(`${path} must be an object`);
  return null;
}

export function integer(c: Check, path: string, value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  c.problems.push(`${path} must be a whole number from ${min} to ${max}`);
  return fallback;
}

export function flag(c: Check, path: string, value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  c.problems.push(`${path} must be true or false`);
  return fallback;
}

export function unique(c: Check, path: string, names: (string | null)[], what: string) {
  const seen = new Set<string>();
  for (const name of names) {
    if (name === null) continue;
    if (seen.has(name)) c.problems.push(`${path} has two ${what} named ${name}`);
    seen.add(name);
  }
}

export const symbolOf = (c: Check, path: string, value: unknown, fallback = "puzzlepiece") => matching(c, path, value, SYMBOL, SYMBOL_RULE, false) ?? fallback;

export function isPluginPath(value: string): boolean {
  if (!value || value.length > LIMITS.argBytes || !isWellFormed(value) || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const isArgument = (arg: unknown): arg is string => typeof arg === "string" && arg.length > 0 && isWellFormed(arg) && new TextEncoder().encode(arg).length <= LIMITS.argBytes && !arg.includes("\0");

export function pluginFile(c: Check, path: string, value: unknown, rule: string, extension?: string): string | null {
  if (typeof value === "string" && isPluginPath(value) && (!extension || value.toLowerCase().endsWith(extension))) return value;
  c.problems.push(`${path} must be ${rule}`);
  return null;
}
