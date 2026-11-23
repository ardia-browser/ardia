import type { Fields } from "./decode";
import { at, flag, KEY, KEY_RULE, KEYWORD, LIMITS, list, matching, NAME, object, only, pluginFile, symbolOf, text, unique, type Check } from "./pluginChecks";
import { command, SPLIT_SIDES, tool, whenOf, type CommandSpec, type PageSide, type ToolSpec } from "./pluginCommands";
import { passwordManagerOf, type PasswordManagerSpec } from "./pluginPasswordManager";
import { pageBarOf, siteSwitchesOf, type PageBarSpec, type SiteSwitchSpec } from "./pluginPageBar";
import { settingsOf, type SettingsSpec } from "./pluginRows";
import { program, type ProgramSpec } from "./pluginRuntime";

export const MENU_SLOTS = ["tab", "group"] as const;
export type MenuSlot = (typeof MENU_SLOTS)[number];
export const PANEL_MODES = ["sidecar", "tab", "split"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

export type MenuContribution = { command: string; title?: string; icon?: string; when?: string };
export type MenuContributions = Record<MenuSlot, MenuContribution[]>;
export type ToolbarItem = { id: string; title: string; icon: string; command?: string; view?: string; tooltip?: string };
export type SidebarView = { id: string; title: string; icon: string };
export type PanelSpec = { id: string; title: string; icon: string; mode: PanelMode; file?: string; view?: string; retainContext: boolean; side?: PageSide };
export type OmniboxSpec = { id: string; title: string; keyword?: string; global: boolean };
export type ThemeSpec = { id: string; title: string; file: string };

export type PluginContributions = {
  commands: CommandSpec[];
  tools: ToolSpec[];
  hooks: string[];
  settings: SettingsSpec;
  programs: ProgramSpec[];
  passwordManager: PasswordManagerSpec | null;
  menus: MenuContributions;
  toolbar: ToolbarItem[];
  sidebarViews: SidebarView[];
  panels: PanelSpec[];
  omnibox: OmniboxSpec[];
  themes: ThemeSpec[];
  siteSwitches: SiteSwitchSpec[];
  pageBar: PageBarSpec | null;
};

export const CONTRIBUTES_KEYS = ["commands", "tools", "hooks", "settings", "programs", "passwordManager", "menus", "toolbar", "sidebarViews", "panels", "omnibox", "themes", "siteSwitches", "pageBar"] as const;
export const PAGE_PANEL_ID = "default";

const emptyMenus = (): MenuContributions => ({ tab: [], group: [] });

const P = "contributes";

function menuItem(c: Check, path: string, value: unknown): MenuContribution | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["command", "title", "icon", "when"]);
  const name = matching(c, `${path}.command`, doc.command, NAME, "one of the plugin's commands");
  const title = text(c, `${path}.title`, doc.title, LIMITS.title, false);
  const icon = doc.icon === undefined ? null : symbolOf(c, `${path}.icon`, doc.icon);
  const when = whenOf(c, `${path}.when`, doc.when);
  return name ? { command: name, ...(title ? { title } : {}), ...(icon ? { icon } : {}), ...(when ? { when } : {}) } : null;
}

function menusOf(c: Check, value: unknown): MenuContributions {
  const out = emptyMenus();
  if (value === undefined) return out;
  const doc = object(c, `${P}.menus`, value);
  if (!doc) return out;
  only(c, `${P}.menus`, doc, MENU_SLOTS);
  for (const slot of MENU_SLOTS) out[slot] = list(c, `${P}.menus.${slot}`, doc[slot], LIMITS.menuItems).flatMap((m, i) => menuItem(c, at(`${P}.menus.${slot}`, i), m) ?? []);
  return out;
}

function idOf(c: Check, path: string, doc: Fields) {
  return matching(c, `${path}.id`, doc.id, KEY, KEY_RULE);
}

function toolbarItem(c: Check, path: string, value: unknown): ToolbarItem | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["id", "title", "icon", "command", "view", "tooltip"]);
  const id = idOf(c, path, doc);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const icon = matching(c, `${path}.icon`, doc.icon, /^[a-z0-9.]{1,64}$/, "an SF Symbol name");
  const tooltip = text(c, `${path}.tooltip`, doc.tooltip, LIMITS.tooltip, false);
  if ((doc.command === undefined) === (doc.view === undefined)) c.problems.push(`${path} needs either command or view`);
  const cmd = doc.command === undefined ? null : matching(c, `${path}.command`, doc.command, NAME, "one of the plugin's commands");
  const view = doc.view === undefined ? null : matching(c, `${path}.view`, doc.view, KEY, KEY_RULE);
  if (!id || !title || !icon || (!cmd && !view)) return null;
  return { id, title, icon, ...(cmd ? { command: cmd } : {}), ...(view ? { view } : {}), ...(tooltip ? { tooltip } : {}) };
}

function sidebarView(c: Check, path: string, value: unknown): SidebarView | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["id", "title", "icon"]);
  const id = idOf(c, path, doc);
  const title = text(c, `${path}.title`, doc.title, LIMITS.pageTitle);
  const icon = symbolOf(c, `${path}.icon`, doc.icon);
  return id && title ? { id, title, icon } : null;
}

function panel(c: Check, path: string, value: unknown): PanelSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["id", "title", "icon", "mode", "file", "view", "retainContext", "side", "served"]);
  if (doc.served !== undefined) {
    c.problems.push(`${path}.served is gone: a page is static files from the plugin's folder (page.file), and it talks to its helper with window.ardia.send`);
    return null;
  }
  const id = idOf(c, path, doc);
  const title = text(c, `${path}.title`, doc.title, LIMITS.pageTitle);
  const icon = symbolOf(c, `${path}.icon`, doc.icon);
  const mode = (PANEL_MODES as readonly unknown[]).includes(doc.mode) ? (doc.mode as PanelMode) : (c.problems.push(`${path}.mode must be ${PANEL_MODES.join(", ")}`), null);
  const retainContext = flag(c, `${path}.retainContext`, doc.retainContext);
  if (doc.file !== undefined && doc.view !== undefined) c.problems.push(`${path} takes a file or a view, not both`);
  if (doc.file === undefined && doc.view === undefined) {
    c.problems.push(`${path}.file must be a path inside the plugin's folder, like page/index.html, or the panel needs a view`);
    return null;
  }
  const file = doc.file === undefined ? null : pluginFile(c, `${path}.file`, doc.file, "a path inside the plugin's folder, like page/index.html");
  const view = doc.view === undefined ? null : matching(c, `${path}.view`, doc.view, KEY, KEY_RULE);
  if (doc.side !== undefined && mode !== "split") c.problems.push(`${path}.side only goes with mode split`);
  const side = doc.side === undefined ? undefined : (SPLIT_SIDES as readonly unknown[]).includes(doc.side) ? (doc.side as PageSide) : (c.problems.push(`${path}.side must be left, right, top or bottom`), undefined);
  if (!id || !title || !mode || (!file && !view)) return null;
  return { id, title, icon, mode, ...(file ? { file } : {}), ...(view ? { view } : {}), retainContext, ...(side ? { side } : {}) };
}

function omnibox(c: Check, path: string, value: unknown): OmniboxSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["id", "title", "keyword", "global"]);
  const id = idOf(c, path, doc);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const keyword = matching(c, `${path}.keyword`, doc.keyword, KEYWORD, "1 to 32 letters, digits, - and _", false);
  const global = flag(c, `${path}.global`, doc.global);
  if (!keyword && !global) c.problems.push(`${path} needs a keyword or global: true, or it never shows`);
  if (keyword && global) c.problems.push(`${path} takes a keyword or global: true, not both`);
  return id && title ? { id, title, ...(keyword ? { keyword } : {}), global } : null;
}

function theme(c: Check, path: string, value: unknown): ThemeSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["id", "title", "file"]);
  const id = idOf(c, path, doc);
  const title = text(c, `${path}.title`, doc.title, LIMITS.title);
  const file = pluginFile(c, `${path}.file`, doc.file, "a .json file inside the plugin's folder, like themes/dusk.json", ".json");
  return id && title && file ? { id, title, file } : null;
}

function parsed<T>(c: Check, key: string, value: unknown, max: number, read: (c: Check, path: string, v: unknown) => T | null, ids: (t: T) => string, what: string): T[] {
  const out = list(c, `${P}.${key}`, value, max).flatMap((v, i) => read(c, at(`${P}.${key}`, i), v) ?? []);
  unique(c, `${P}.${key}`, out.map(ids), what);
  return out;
}

export function contributesOf(c: Check, value: unknown, hasMain: boolean): PluginContributions {
  const doc = value === undefined ? {} : (object(c, P, value) ?? {});
  only(c, P, doc, CONTRIBUTES_KEYS);
  const pm: string[] = [];
  const passwordManager = passwordManagerOf(pm, doc.passwordManager);
  c.problems.push(...pm.map((p) => `${P}.${p}`));
  const settings = settingsOf(c, `${P}.settings`, doc.settings);
  const siteSwitches = siteSwitchesOf(c, doc.siteSwitches);
  return {
    commands: parsed(c, "commands", doc.commands, LIMITS.commands, (cc, p, v) => command(cc, p, v, hasMain), (x) => x.name, "commands"),
    tools: parsed(c, "tools", doc.tools, LIMITS.tools, tool, (t) => t.name, "tools"),
    hooks: list(c, `${P}.hooks`, doc.hooks, LIMITS.hooks).flatMap((h, i) => (typeof h === "string" && h ? [h] : (c.problems.push(`${at(`${P}.hooks`, i)} must be an event name`), []))),
    settings,
    programs: parsed(c, "programs", doc.programs, LIMITS.programs, program, (p) => p.name, "programs"),
    passwordManager,
    menus: menusOf(c, doc.menus),
    toolbar: parsed(c, "toolbar", doc.toolbar, LIMITS.toolbar, toolbarItem, (t) => t.id, "toolbar items"),
    sidebarViews: parsed(c, "sidebarViews", doc.sidebarViews, LIMITS.sidebarViews, sidebarView, (v) => v.id, "sidebar views"),
    panels: parsed(c, "panels", doc.panels, LIMITS.panels, panel, (p) => p.id, "panels"),
    omnibox: parsed(c, "omnibox", doc.omnibox, LIMITS.omnibox, omnibox, (o) => o.id, "omnibox providers"),
    themes: parsed(c, "themes", doc.themes, LIMITS.themes, theme, (t) => t.id, "themes"),
    siteSwitches,
    pageBar: pageBarOf(c, doc.pageBar, siteSwitches, settings.rows),
  };
}

export function pagePanelOf(panels: readonly PanelSpec[]): PanelSpec | null {
  const pages = panels.filter((p) => p.file && (p.mode === "tab" || p.mode === "split"));
  return pages.find((p) => p.id === PAGE_PANEL_ID) ?? pages[0] ?? null;
}

export const viewIdsOf = (k: PluginContributions): string[] => [
  ...new Set([...k.sidebarViews.map((v) => v.id), ...k.panels.flatMap((p) => (p.view ? [p.view] : [])), ...k.toolbar.flatMap((t) => (t.view ? [t.view] : [])), ...k.commands.flatMap((x) => ("view" in x.action ? [x.action.view] : []))]),
];
