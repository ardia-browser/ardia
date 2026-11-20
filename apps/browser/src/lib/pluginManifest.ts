import { isFields, type Fields } from "./decode";
import { upgraded, type Migrations } from "./savedDocument";
import { isPagePath, isWellFormed, RESERVED_PAGE_NAMES } from "./pluginNames";
import { passwordManagerOf, type PasswordManagerSpec } from "./pluginPasswordManager";

export { compareVersions } from "./versions";

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = "plugin.json";

export const PLUGIN_PERMISSIONS = ["tabs", "fullUrls", "commands", "network", "control"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const ROW_TYPES = ["toggle", "text", "choice"] as const;
export type RowType = (typeof ROW_TYPES)[number];

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
  tools: 32,
  toolTimeout: [1, 300],
  argv: 32,
  argBytes: 1024,
  memoryMB: [64, 4096],
  programs: 4,
  afterUpdate: [4, 8],
} as const;

export const NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
export const KEY_PATTERN = "^[A-Za-z0-9_-]{1,40}$";
export const VERSION_PATTERN = "^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}(-[0-9A-Za-z.-]{1,40})?$";
export const SYMBOL_PATTERN = "^[a-z0-9.]{1,64}$";
const NAME = new RegExp(NAME_PATTERN);
const KEY = new RegExp(KEY_PATTERN);
const VERSION = new RegExp(VERSION_PATTERN);
const SYMBOL = new RegExp(SYMBOL_PATTERN);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

export type RowSpec =
  | { key: string; title: string; description?: string; type: "toggle"; default: boolean }
  | { key: string; title: string; description?: string; type: "text"; default: string }
  | { key: string; title: string; description?: string; type: "choice"; default: string; choices: { value: string; title: string }[] };

export const SPLIT_SIDES = ["left", "right", "top", "bottom"] as const;
export type PageSide = (typeof SPLIT_SIDES)[number];

export type CommandAction =
  | { tool: string; input: Fields }
  | { open: "tab" | "split"; context: boolean; side: PageSide; sideSetting: string | null; path: string };
export type CommandSpec = { name: string; title: string; icon: string; keywords: string[]; action: CommandAction };
export type ToolSpec = { name: string; title: string; description: string; timeout: number };
export type PageSpec = { title: string; icon: string; source: { file: string } };
export type ProcessSpec = { run: string[]; memoryMB: number };
export type ProgramSpec = { name: string; path: string; afterUpdate: string[][] };

export type PluginManifest = {
  manifest: number;
  name: string;
  title: string;
  description: string;
  version: string | null;
  requires: string | null;
  permissions: PluginPermission[];
  settings: { defaults: Fields; rows: RowSpec[] };
  commands: CommandSpec[];
  page: PageSpec | null;
  process: ProcessSpec | null;
  programs: ProgramSpec[]; passwordManager: PasswordManagerSpec | null;
  alwaysOn: boolean; official: boolean; autoInstall: boolean; icon: string | null;
  hooks: string[];
  tools: ToolSpec[];
};

export type ManifestRead = { manifest: PluginManifest | null; problems: string[]; newer: boolean };

export const MANIFEST_MIGRATIONS: Migrations = {
  0: (doc) => {
    const { settings, reset: _reset, ...rest } = doc;
    return settings === undefined ? rest : { ...rest, settings: { defaults: settings } };
  },
};

type Check = { problems: string[] };

const at = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

function only(c: Check, path: string, doc: Fields, keys: readonly string[]) {
  for (const key of Object.keys(doc)) if (!keys.includes(key)) c.problems.push(`${at(path, key)} isn't a key ${path ? `of ${path}` : "of a plugin"}`);
}

function text(c: Check, path: string, value: unknown, max: number, required = true): string | null {
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

function matching(c: Check, path: string, value: unknown, pattern: RegExp, rule: string, required = true): string | null {
  if (value === undefined && !required) return null;
  if (typeof value === "string" && pattern.test(value)) return value;
  c.problems.push(`${path} must be ${rule}`);
  return null;
}

function list(c: Check, path: string, value: unknown, max: number): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length <= max) return value;
  c.problems.push(`${path} must be a list of at most ${max}`);
  return [];
}

function object(c: Check, path: string, value: unknown): Fields | null {
  if (isFields(value)) return value;
  c.problems.push(`${path} must be an object`);
  return null;
}

function integer(c: Check, path: string, value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  c.problems.push(`${path} must be a whole number from ${min} to ${max}`);
  return fallback;
}

function unique(c: Check, path: string, names: (string | null)[], what: string) {
  const seen = new Set<string>();
  for (const name of names) {
    if (name === null) continue;
    if (seen.has(name)) c.problems.push(`${path} has two ${what} named ${name}`);
    seen.add(name);
  }
}

const NAME_RULE = "1 to 40 lowercase letters, digits and dashes, starting with a letter or digit";
const KEY_RULE = "1 to 40 letters, digits, - and _";

function row(c: Check, path: string, value: unknown): RowSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["key", "title", "description", "type", "default", "choices"]);
  const key = matching(c, `${path}.key`, doc.key, KEY, KEY_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const description = text(c, `${path}.description`, doc.description, LIMITS.description, false) ?? undefined;
  const type = doc.type as RowType;
  if (!(ROW_TYPES as readonly unknown[]).includes(type)) {
    c.problems.push(`${path}.type must be toggle, text or choice`);
    return null;
  }
  if (type !== "choice" && doc.choices !== undefined) c.problems.push(`${path}.choices only goes with type choice`);
  if (!key || !title) return null;
  const base = { key, title, ...(description ? { description } : {}) };
  if (type === "toggle") {
    if (typeof doc.default !== "boolean") return void c.problems.push(`${path}.default must be true or false`), null;
    return { ...base, type, default: doc.default };
  }
  if (type === "text") {
    if (typeof doc.default !== "string" || doc.default.length > LIMITS.rowText || UNSAFE_TEXT.test(doc.default))
      return void c.problems.push(`${path}.default must be text of at most ${LIMITS.rowText} characters`), null;
    return { ...base, type, default: doc.default };
  }
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
  return { ...base, type, default: doc.default as string, choices };
}

function settingsOf(c: Check, value: unknown): PluginManifest["settings"] {
  if (value === undefined) return { defaults: {}, rows: [] };
  const doc = object(c, "settings", value);
  if (!doc) return { defaults: {}, rows: [] };
  only(c, "settings", doc, ["defaults", "rows"]);
  const defaults = doc.defaults === undefined ? {} : (object(c, "settings.defaults", doc.defaults) ?? {});
  const rows = list(c, "settings.rows", doc.rows, LIMITS.rows).flatMap((r, i) => row(c, at("settings.rows", i), r) ?? []);
  unique(c, "settings.rows", rows.map((r) => r.key), "rows");
  return { defaults, rows };
}

function command(c: Check, path: string, value: unknown): CommandSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["name", "title", "icon", "keywords", "tool", "input", "open", "context", "side", "sideSetting", "path"]);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const icon = matching(c, `${path}.icon`, doc.icon, SYMBOL, "an SF Symbol name", false) ?? "puzzlepiece";
  const keywords = list(c, `${path}.keywords`, doc.keywords, LIMITS.keywords).flatMap((k, i) => text(c, at(`${path}.keywords`, i), k, LIMITS.keyword) ?? []);
  if ((doc.tool === undefined) === (doc.open === undefined)) {
    c.problems.push(`${path} needs either tool (one of the plugin's tools) or open ("tab" or "split")`);
    return null;
  }
  let action: CommandAction | null = null;
  if (doc.tool !== undefined) {
    for (const key of ["context", "side", "sideSetting", "path"]) if (doc[key] !== undefined) c.problems.push(`${path}.${key} only goes with open`);
    const tool = matching(c, `${path}.tool`, doc.tool, NAME, "a tool's name");
    const input = doc.input === undefined ? {} : object(c, `${path}.input`, doc.input);
    action = tool && input ? { tool, input } : null;
  } else {
    if (doc.input !== undefined) c.problems.push(`${path}.input only goes with tool`);
    const open = doc.open === "tab" || doc.open === "split" ? doc.open : (c.problems.push(`${path}.open must be tab or split`), null);
    if (doc.context !== undefined && typeof doc.context !== "boolean") c.problems.push(`${path}.context must be true or false`);
    const side = doc.side === undefined ? "right" : (SPLIT_SIDES as readonly unknown[]).includes(doc.side) ? (doc.side as PageSide) : (c.problems.push(`${path}.side must be left, right, top or bottom`), null);
    const sideSetting = doc.sideSetting === undefined ? null : matching(c, `${path}.sideSetting`, doc.sideSetting, KEY, "a row's key");
    if (open !== "split" && (doc.side !== undefined || doc.sideSetting !== undefined)) c.problems.push(`${path}: side and sideSetting only go with open: split`);
    const pagePath = doc.path === undefined ? "" : typeof doc.path === "string" && isPagePath(doc.path) ? doc.path : (c.problems.push(`${path}.path must be /like/this?q=1`), null);
    action = open && side && pagePath !== null ? { open, context: doc.context === true, side, sideSetting, path: pagePath } : null;
  }
  return name && title && action ? { name, title, icon, keywords, action } : null;
}

function tool(c: Check, path: string, value: unknown): ToolSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["name", "title", "description", "timeout"]);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const description = text(c, `${path}.description`, doc.description, LIMITS.description, false) ?? "";
  const timeout = integer(c, `${path}.timeout`, doc.timeout, LIMITS.toolTimeout, 30);
  return name && title ? { name, title, description, timeout } : null;
}

export function isPluginPath(value: string): boolean {
  if (!value || value.length > LIMITS.argBytes || !isWellFormed(value) || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function pageOf(c: Check, value: unknown): PageSpec | null {
  if (value === undefined) return null;
  const doc = object(c, "page", value);
  if (!doc) return null;
  only(c, "page", doc, ["title", "icon", "file", "served"]);
  const title = text(c, "page.title", doc.title, LIMITS.pageTitle);
  const icon = matching(c, "page.icon", doc.icon, SYMBOL, "an SF Symbol name", false) ?? "puzzlepiece";
  if (doc.served !== undefined) {
    c.problems.push("page.served is gone: a page is static files from the plugin's folder (page.file), and it talks to its helper with window.ardia.send");
    return null;
  }
  if (typeof doc.file !== "string" || !isPluginPath(doc.file)) {
    c.problems.push("page.file must be a path inside the plugin's folder, like page/index.html");
    return null;
  }
  if (!title) return null;
  return { title, icon, source: { file: doc.file as string } };
}

const isArgument = (arg: unknown): arg is string => typeof arg === "string" && arg.length > 0 && isWellFormed(arg) && new TextEncoder().encode(arg).length <= LIMITS.argBytes && !arg.includes("\0");

function processOf(c: Check, value: unknown): ProcessSpec | null {
  if (value === undefined) return null;
  const doc = object(c, "process", value);
  if (!doc) return null;
  only(c, "process", doc, ["run", "memoryMB"]);
  const run = doc.run;
  const okArgs = Array.isArray(run) && run.length > 0 && run.length <= LIMITS.argv && run.every(isArgument);
  if (!okArgs) {
    c.problems.push(`process.run must be a list of 1 to ${LIMITS.argv} arguments, the program first`);
    return null;
  }
  const program = run[0] as string;
  if (!program.startsWith("/") && program.includes("/") && !isPluginPath(program)) c.problems.push("process.run[0] must be a file in the plugin's folder, an absolute path or a program name");
  const memoryMB = integer(c, "process.memoryMB", doc.memoryMB, LIMITS.memoryMB, 1024);
  return { run: run as string[], memoryMB };
}

function program(c: Check, path: string, value: unknown): ProgramSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["name", "path", "afterUpdate"]);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const file = typeof doc.path === "string" && isPluginPath(doc.path) ? doc.path : (c.problems.push(`${path}.path must be a file in the plugin's folder, like bin/tool`), null);
  const after = doc.afterUpdate === undefined ? [] : Array.isArray(doc.afterUpdate) && doc.afterUpdate.length <= LIMITS.afterUpdate[0] && doc.afterUpdate.every((a) => Array.isArray(a) && a.length > 0 && a.length <= LIMITS.afterUpdate[1] && a.every(isArgument)) ? (doc.afterUpdate as string[][]) : (c.problems.push(`${path}.afterUpdate must be a list of at most ${LIMITS.afterUpdate[0]} argument lists of 1 to ${LIMITS.afterUpdate[1]}`), null);
  return name && file && after ? { name, path: file, afterUpdate: after } : null;
}

function permissionsOf(c: Check, value: unknown): PluginPermission[] {
  const given = list(c, "permissions", value, PLUGIN_PERMISSIONS.length);
  const out: PluginPermission[] = [];
  for (const p of given) {
    if ((PLUGIN_PERMISSIONS as readonly unknown[]).includes(p)) {
      if (!out.includes(p as PluginPermission)) out.push(p as PluginPermission);
    } else c.problems.push(`permissions has ${JSON.stringify(p)}, which isn't one of ${PLUGIN_PERMISSIONS.join(", ")}`);
  }
  if (out.includes("fullUrls") && !out.includes("tabs")) c.problems.push("permissions: fullUrls needs tabs");
  return out;
}

const TOP_KEYS = ["$schema", "manifest", "name", "title", "description", "version", "requires", "permissions", "settings", "commands", "page", "process", "programs", "passwordManager", "alwaysOn", "official", "autoInstall", "icon", "hooks", "tools"];

export function checkManifest(raw: Fields): { manifest: PluginManifest | null; problems: string[] } {
  const c: Check = { problems: [] };
  only(c, "", raw, TOP_KEYS);
  const name = matching(c, "name", raw.name, NAME, NAME_RULE);
  const title = text(c, "title", raw.title ?? raw.name, LIMITS.title);
  const description = text(c, "description", raw.description, LIMITS.description, false) ?? "";
  const version = matching(c, "version", raw.version, VERSION, "MAJOR.MINOR.PATCH", false);
  const requires = matching(c, "requires", raw.requires, VERSION, "an Ardia version, MAJOR.MINOR.PATCH", false);
  const permissions = permissionsOf(c, raw.permissions);
  const settings = settingsOf(c, raw.settings);
  const tools = list(c, "tools", raw.tools, LIMITS.tools).flatMap((t, i) => tool(c, at("tools", i), t) ?? []);
  unique(c, "tools", tools.map((t) => t.name), "tools");
  const commands = list(c, "commands", raw.commands, LIMITS.commands).flatMap((x, i) => command(c, at("commands", i), x) ?? []);
  unique(c, "commands", commands.map((x) => x.name), "commands");
  const page = pageOf(c, raw.page);
  const process = processOf(c, raw.process);
  const [alwaysOn, official, autoInstall] = (["alwaysOn", "official", "autoInstall"] as const).map((k) => (raw[k] === undefined ? false : raw[k] === true || (c.problems.push(`${k} must be true`), false)));
  const icon = matching(c, "icon", raw.icon, SYMBOL, "an SF Symbol name", false), passwordManager = passwordManagerOf(c.problems, raw.passwordManager);
  const programs = list(c, "programs", raw.programs, LIMITS.programs).flatMap((p, i) => program(c, at("programs", i), p) ?? []);
  unique(c, "programs", programs.map((p) => p.name), "programs");
  const hooks = list(c, "hooks", raw.hooks, 64).flatMap((h, i) => (typeof h === "string" && h ? [h] : (c.problems.push(`${at("hooks", i)} must be an event name`), [])));
  commands.forEach((x, i) => {
    const action = x.action;
    if ("tool" in action) {
      if (!tools.some((t) => t.name === action.tool)) c.problems.push(`commands[${i}].tool: ${action.tool} isn't one of this plugin's tools`);
      return;
    }
    if (!page) c.problems.push(`commands[${i}].open needs a page`);
    if (action.context && !permissions.includes("tabs")) c.problems.push(`commands[${i}].context needs the tabs permission`);
    const row = action.sideSetting ? settings.rows.find((r) => r.key === action.sideSetting) : undefined;
    if (action.sideSetting && (!row || row.type !== "choice" || !row.choices.every((ch) => (SPLIT_SIDES as readonly string[]).includes(ch.value))))
      c.problems.push(`commands[${i}].sideSetting must name a choice row whose values are left, right, top or bottom`);
  });
  if (page && name && RESERVED_PAGE_NAMES.includes(name)) c.problems.push(`name: ${name} is one of Ardia's own pages (ardia://${name}), so a plugin with a page can't use it`);
  const needsProcess: [string, boolean][] = [["tool commands", commands.some((x) => "tool" in x.action)], ["tools", tools.length > 0], ["hooks", hooks.length > 0]];
  for (const [what, used] of needsProcess) if (used && !process) c.problems.push(`${what} needs a process`);
  if (c.problems.length || !name || !title) return { manifest: null, problems: c.problems };
  return {
    manifest: { manifest: MANIFEST_VERSION, name, title, description, version, requires, permissions, settings, commands, page, process, programs, passwordManager, alwaysOn: !!alwaysOn, official: !!official, autoInstall: !!autoInstall, icon, hooks, tools },
    problems: [],
  };
}

export function readManifest(text: string): ManifestRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { manifest: null, problems: [`${MANIFEST_FILE} isn't valid JSON (${(error as Error).message})`], newer: false };
  }
  if (!isFields(doc)) return { manifest: null, problems: [`${MANIFEST_FILE} must be an object`], newer: false };
  const given = doc.manifest;
  if (given !== undefined && (typeof given !== "number" || !Number.isSafeInteger(given) || given < 0))
    return { manifest: null, problems: ["manifest must be a whole number, the manifest's version"], newer: false };
  if (typeof given === "number" && given > MANIFEST_VERSION)
    return { manifest: null, problems: [`manifest ${given} needs a newer Ardia (this one reads up to ${MANIFEST_VERSION})`], newer: true };
  const current = upgraded(doc, MANIFEST_VERSION, MANIFEST_MIGRATIONS, "manifest");
  if (!current) return { manifest: null, problems: [`${MANIFEST_FILE} couldn't be read`], newer: false };
  const { manifest, problems } = checkManifest(current);
  return { manifest, problems: problems.map((p) => `${MANIFEST_FILE}: ${p}`), newer: false };
}

export type Contribution = "settings" | "commands" | "page" | "process" | "programs" | "hooks" | "tools" | "passwordManager";
export const CONTRIBUTIONS: readonly Contribution[] = ["settings", "commands", "page", "process", "programs", "hooks", "tools", "passwordManager"];

export function contributionsOf(m: PluginManifest): Contribution[] {
  const has: Record<Contribution, boolean> = {
    settings: Object.keys(m.settings.defaults).length > 0 || m.settings.rows.length > 0,
    commands: m.commands.length > 0,
    page: m.page !== null,
    process: m.process !== null,
    programs: m.programs.length > 0,
    hooks: m.hooks.length > 0,
    tools: m.tools.length > 0, passwordManager: m.passwordManager !== null,
  };
  return CONTRIBUTIONS.filter((c) => has[c]);
}

export function defaultValues(m: PluginManifest): Record<string, string | boolean> {
  return Object.fromEntries(m.settings.rows.map((r) => [r.key, r.default]));
}

export function rowValue(r: RowSpec, value: unknown): string | boolean {
  if (r.type === "toggle") return typeof value === "boolean" ? value : r.default;
  if (r.type === "text") return typeof value === "string" && value.length <= LIMITS.rowText && !UNSAFE_TEXT.test(value) ? value : r.default;
  return typeof value === "string" && r.choices.some((x) => x.value === value) ? value : r.default;
}
