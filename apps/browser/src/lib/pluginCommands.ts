import type { Fields } from "./decode";
import { at, integer, KEY, KEY_RULE, LIMITS, list, matching, NAME, NAME_RULE, object, only, symbolOf, text, type Check } from "./pluginChecks";
import { isPagePath } from "./pluginNames";
import { parseWhen } from "./pluginWhen";
import { t } from "./uiLanguage";


export const SPLIT_SIDES = ["left", "right", "top", "bottom"] as const;
export type PageSide = (typeof SPLIT_SIDES)[number];

export type CommandAction =
  | { tool: string; input: Fields }
  | { open: "tab" | "split"; context: boolean; side: PageSide; sideSetting: string | null; path: string }
  | { view: string }
  | { panel: string }
  | { handler: true };
export type CommandSpec = { name: string; title: string; icon: string; keywords: string[]; when?: string; action: CommandAction };
export type ToolSpec = { name: string; title: string; description: string; timeout: number };

const COMMAND_KEYS = ["name", "title", "icon", "keywords", "when", "tool", "input", "open", "context", "side", "sideSetting", "path", "view", "panel", "handler"];
const ACTION_KEYS = ["tool", "open", "view", "panel", "handler"] as const;
const OPEN_ONLY = ["context", "side", "sideSetting", "path"];

export function whenOf(c: Check, path: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return void c.problems.push(`${path} must be text`), undefined;
  const read = parseWhen(value);
  if (!read.ok) return void c.problems.push(`${path} ${read.problem}`), undefined;
  return value;
}

function openAction(c: Check, path: string, doc: Fields): CommandAction | null {
  if (doc.input !== undefined) c.problems.push(`${path}.input only goes with tool`);
  const open = doc.open === "tab" || doc.open === "split" ? doc.open : (c.problems.push(`${path}.open must be tab or split`), null);
  if (doc.context !== undefined && typeof doc.context !== "boolean") c.problems.push(`${path}.context must be true or false`);
  const side = doc.side === undefined ? "right" : (SPLIT_SIDES as readonly unknown[]).includes(doc.side) ? (doc.side as PageSide) : (c.problems.push(`${path}.side must be left, right, top or bottom`), null);
  const sideSetting = doc.sideSetting === undefined ? null : matching(c, `${path}.sideSetting`, doc.sideSetting, KEY, t(`a row's key`));
  if (open !== "split" && (doc.side !== undefined || doc.sideSetting !== undefined)) c.problems.push(`${path}: side and sideSetting only go with open: split`);
  const pagePath = doc.path === undefined ? "" : typeof doc.path === "string" && isPagePath(doc.path) ? doc.path : (c.problems.push(`${path}.path must be /like/this?q=1`), null);
  return open && side && pagePath !== null ? { open, context: doc.context === true, side, sideSetting, path: pagePath } : null;
}

function actionOf(c: Check, path: string, doc: Fields, hasMain: boolean): CommandAction | null {
  const given = ACTION_KEYS.filter((k) => doc[k] !== undefined);
  if (given.length > 1 || (given.length === 0 && !hasMain)) {
    c.problems.push(given.length > 1 ? `${path} needs either tool, open, view, panel or handler, not more than one` : `${path} needs either tool (one of the plugin's tools) or open ("tab" or "split"), or a main to handle it`);
    return null;
  }
  const kind = given[0] ?? "handler";
  if (kind !== "open") for (const key of OPEN_ONLY) if (doc[key] !== undefined) c.problems.push(`${path}.${key} only goes with open`);
  if (kind !== "tool" && kind !== "open" && doc.input !== undefined) c.problems.push(`${path}.input only goes with tool`);
  if (kind === "tool") {
    const tool = matching(c, `${path}.tool`, doc.tool, NAME, t(`a tool's name`));
    const input = doc.input === undefined ? {} : object(c, `${path}.input`, doc.input);
    return tool && input ? { tool, input } : null;
  }
  if (kind === "open") return openAction(c, path, doc);
  if (kind === "view") {
    const view = matching(c, `${path}.view`, doc.view, KEY, KEY_RULE);
    return view ? { view } : null;
  }
  if (kind === "panel") {
    const panel = matching(c, `${path}.panel`, doc.panel, KEY, t(`a panel's id`));
    return panel ? { panel } : null;
  }
  if (doc.handler !== undefined && doc.handler !== true) c.problems.push(`${path}.handler must be true`);
  return { handler: true };
}

export function command(c: Check, path: string, value: unknown, hasMain: boolean): CommandSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, COMMAND_KEYS);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const icon = symbolOf(c, `${path}.icon`, doc.icon);
  const keywords = list(c, `${path}.keywords`, doc.keywords, LIMITS.keywords).flatMap((k, i) => text(c, at(`${path}.keywords`, i), k, LIMITS.keyword) ?? []);
  const when = whenOf(c, `${path}.when`, doc.when);
  const action = actionOf(c, path, doc, hasMain);
  if (!name || !title || !action) return null;
  return { name, title, icon, keywords, ...(when ? { when } : {}), action };
}

export function tool(c: Check, path: string, value: unknown): ToolSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["name", "title", "description", "timeout"]);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const description = text(c, `${path}.description`, doc.description, LIMITS.description, false) ?? "";
  const timeout = integer(c, `${path}.timeout`, doc.timeout, LIMITS.toolTimeout, 30);
  return name && title ? { name, title, description, timeout } : null;
}

export const isToolAction = (a: CommandAction): a is Extract<CommandAction, { tool: string }> => "tool" in a;
export const isOpenAction = (a: CommandAction): a is Extract<CommandAction, { open: string }> => "open" in a;
export const isViewAction = (a: CommandAction): a is Extract<CommandAction, { view: string }> => "view" in a;
export const isPanelAction = (a: CommandAction): a is Extract<CommandAction, { panel: string }> => "panel" in a;
export const isHandlerAction = (a: CommandAction): a is Extract<CommandAction, { handler: true }> => "handler" in a;
