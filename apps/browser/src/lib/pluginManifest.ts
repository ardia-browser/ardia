import { isFields, type Fields } from "./decode";
import { upgraded } from "./savedDocument";
import { RESERVED_PAGE_NAMES } from "./pluginNames";
import { LIMITS, list, matching, NAME, NAME_RULE, object, only, text, VERSION, type Check, SYMBOL, SYMBOL_RULE } from "./pluginChecks";
import { SPLIT_SIDES, type CommandSpec } from "./pluginCommands";
import { contributesOf, MENU_SLOTS, pagePanelOf, type PluginContributions } from "./pluginContributions";
import { activationEventsOf, derivedActivationEvents } from "./pluginActivation";
import { MANIFEST_MIGRATIONS, v1Problem } from "./pluginMigrations";
import { ANY_HOST } from "./pluginNetwork";
import { permissionsOf, type PluginPermissions } from "./pluginPermissions";
import { storedRows, type RowValue, type SettingsSpec } from "./pluginRows";
import { mainOf, sidecarOf, type MainSpec, type ProcessSpec, type ProgramSpec } from "./pluginRuntime";
import type { PasswordManagerSpec } from "./pluginPasswordManager";
import { t } from "./uiLanguage";


export { compareVersions } from "./versions";
export { LIMITS, NAME_PATTERN, KEY_PATTERN, VERSION_PATTERN, SYMBOL_PATTERN, KEYWORD_PATTERN, isPluginPath, DEFAULT_MAIN_MB, DEFAULT_SIDECAR_MB } from "./pluginChecks";
export { ROW_TYPES, rowValue, storedRows, secretRows, type RowSpec, type RowType, type RowValue, type SettingsSpec } from "./pluginRows";
export { SPLIT_SIDES, isToolAction, isOpenAction, isViewAction, isPanelAction, isHandlerAction, type PageSide, type CommandAction, type CommandSpec, type ToolSpec } from "./pluginCommands";
export { PLUGIN_PERMISSIONS, PERMISSION_KEYS, NO_PERMISSIONS, TAB_ACCESS, grantedPermissions, missingPermissions, canReadTabs, canOpenTabs, hasNetwork, allowedHostsOf, type PluginPermission, type PluginPermissions, type PermissionKey, type TabAccess, type NetworkAccess } from "./pluginPermissions";
export { MENU_SLOTS, PANEL_MODES, PAGE_PANEL_ID, CONTRIBUTES_KEYS, pagePanelOf, viewIdsOf, type MenuSlot, type PanelMode, type MenuContribution, type MenuContributions, type ToolbarItem, type SidebarView, type PanelSpec, type OmniboxSpec, type ThemeSpec, type PluginContributions } from "./pluginContributions";
export { STARTUP_EVENTS, ACTIVATION_PREFIXES, activationEventProblem, derivedActivationEvents, startsEagerly, urlActivationHosts } from "./pluginActivation";
export { MANIFEST_MIGRATIONS } from "./pluginMigrations";
export type { MainSpec, ProcessSpec, ProgramSpec } from "./pluginRuntime";

export const MANIFEST_VERSION = 2;
export const MANIFEST_FILE = "plugin.json";

export type PageSpec = { title: string; icon: string; source: { file: string } };
export type TelemetryDisclosure = { title: string; items: string[] };

export type PluginManifest = {
  manifest: number;
  declaredManifest: number;
  name: string;
  title: string;
  description: string;
  version: string | null;
  requires: string | null;
  icon: string | null;
  keywords: string[];
  telemetry: TelemetryDisclosure | null;
  permissions: PluginPermissions;
  main: MainSpec | null;
  sidecar: ProcessSpec | null;
  activationEvents: string[];
  contributes: PluginContributions;
  alwaysOn: boolean;
  official: boolean;
  autoInstall: boolean;
  settings: SettingsSpec;
  commands: CommandSpec[];
  tools: PluginContributions["tools"];
  hooks: string[];
  programs: ProgramSpec[];
  passwordManager: PasswordManagerSpec | null;
  page: PageSpec | null;
  process: ProcessSpec | null;
};

export type ManifestRead = { manifest: PluginManifest | null; problems: string[]; newer: boolean };

const TOP_KEYS = ["$schema", "manifest", "name", "title", "description", "version", "requires", "icon", "main", "memoryMB", "sidecar", "activationEvents", "permissions", "contributes", "alwaysOn", "official", "autoInstall", "keywords", "telemetry"];
const V2_ONLY_KEYS = ["keywords", "telemetry"] as const;
const K = "contributes";

function commandProblems(c: Check, k: PluginContributions, permissions: PluginPermissions, hasPage: boolean, hasMain: boolean) {
  k.commands.forEach((x, i) => {
    const path = `${K}.commands[${i}]`;
    const action = x.action;
    if ("tool" in action) {
      if (!k.tools.some((t) => t.name === action.tool)) c.problems.push(`${path}.tool: ${action.tool} isn't one of this plugin's tools`);
    } else if ("open" in action) {
      if (!hasPage) c.problems.push(`${path}.open needs a page`);
      if (action.context && !permissions.tabs) c.problems.push(`${path}.context needs the tabs permission`);
      const row = action.sideSetting ? k.settings.rows.find((r) => r.key === action.sideSetting) : undefined;
      if (action.sideSetting && (!row || row.type !== "choice" || !row.choices.every((ch) => (SPLIT_SIDES as readonly string[]).includes(ch.value))))
        c.problems.push(`${path}.sideSetting must name a choice row whose values are left, right, top or bottom`);
    } else if ("panel" in action) {
      if (!k.panels.some((p) => p.id === action.panel)) c.problems.push(`${path}.panel: ${action.panel} isn't one of this plugin's panels`);
    } else if (!hasMain) c.problems.push(`${path}.${"view" in action ? "view" : "handler"} needs a main`);
  });
}

function contributionProblems(c: Check, k: PluginContributions, permissions: PluginPermissions, runtime: { main: boolean; sidecar: boolean }) {
  const names = new Set(k.commands.map((x) => x.name));
  for (const slot of MENU_SLOTS) k.menus[slot].forEach((m, i) => names.has(m.command) || c.problems.push(`${K}.menus.${slot}[${i}].command: ${m.command} isn't one of this plugin's commands`));
  k.toolbar.forEach((t, i) => {
    if (t.command && !names.has(t.command)) c.problems.push(`${K}.toolbar[${i}].command: ${t.command} isn't one of this plugin's commands`);
    if (t.view && !runtime.main) c.problems.push(`${K}.toolbar[${i}].view needs a main`);
  });
  k.panels.forEach((p, i) => p.view && !runtime.main && c.problems.push(`${K}.panels[${i}].view needs a main`));
  const needsMain: [string, boolean][] = [["sidebarViews", k.sidebarViews.length > 0], ["omnibox", k.omnibox.length > 0]];
  for (const [what, used] of needsMain) if (used && !runtime.main) c.problems.push(`${K}.${what} needs a main`);
  const needsRuntime: [string, boolean][] = [[t(`tool commands`), k.commands.some((x) => "tool" in x.action)], ["tools", k.tools.length > 0], ["hooks", k.hooks.length > 0]];
  for (const [what, used] of needsRuntime) if (used && !runtime.main && !runtime.sidecar) c.problems.push(`${what} needs a main or a sidecar`);
  if (k.settings.rows.some((r) => r.type === "secret") && !permissions.secrets) c.problems.push(`${K}.settings.rows: a secret row needs the secrets permission`);
}

function keywordsOf(c: Check, value: unknown): string[] {
  const given = list(c, "keywords", value, LIMITS.pluginKeywords).map((k, i) => text(c, `keywords[${i}]`, k, LIMITS.keyword));
  return [...new Set(given.filter((k): k is string => k !== null))];
}

function telemetryOf(c: Check, value: unknown): TelemetryDisclosure | null {
  if (value === undefined) return null;
  const doc = object(c, "telemetry", value);
  if (!doc) return null;
  only(c, "telemetry", doc, ["title", "items"]);
  const title = text(c, "telemetry.title", doc.title, LIMITS.title);
  const raw = list(c, "telemetry.items", doc.items, LIMITS.telemetryItems);
  if (!raw.length) c.problems.push(`telemetry.items must be a list of 1 to ${LIMITS.telemetryItems}`);
  const items = raw.map((item, i) => text(c, `telemetry.items[${i}]`, item, LIMITS.telemetryItem));
  return title && raw.length && items.every((i) => i !== null) ? { title, items: items as string[] } : null;
}

function v2OnlyProblems(c: Check, raw: Fields, programs: PluginContributions["programs"], declared: number) {
  if (declared >= MANIFEST_VERSION) return;
  for (const key of V2_ONLY_KEYS) if (raw[key] !== undefined) c.problems.push(`${key} needs manifest ${MANIFEST_VERSION}`);
  programs.forEach((p, i) => {
    if (p.example !== null) c.problems.push(`programs[${i}].example needs manifest ${MANIFEST_VERSION}`);
    if (p.claim) c.problems.push(`programs[${i}].claim needs manifest ${MANIFEST_VERSION}`);
  });
}

function pageOf(k: PluginContributions): PageSpec | null {
  const panel = pagePanelOf(k.panels);
  return panel?.file ? { title: panel.title, icon: panel.icon, source: { file: panel.file } } : null;
}

export function checkManifest(raw: Fields, declaredManifest = MANIFEST_VERSION): { manifest: PluginManifest | null; problems: string[] } {
  const c: Check = { problems: [] };
  only(c, "", raw, TOP_KEYS);
  const name = matching(c, "name", raw.name, NAME, NAME_RULE);
  const title = text(c, "title", raw.title ?? raw.name, LIMITS.title);
  const description = text(c, "description", raw.description, LIMITS.description, false) ?? "";
  const version = matching(c, "version", raw.version, VERSION, "MAJOR.MINOR.PATCH", false);
  const requires = matching(c, "requires", raw.requires, VERSION, t(`an Ardia version, MAJOR.MINOR.PATCH`), false);
  const icon = matching(c, "icon", raw.icon, SYMBOL, SYMBOL_RULE, false);
  const keywords = keywordsOf(c, raw.keywords);
  const telemetry = telemetryOf(c, raw.telemetry);
  const permissions = permissionsOf(c, raw.permissions);
  const main = mainOf(c, raw.main, raw.memoryMB);
  const sidecar = sidecarOf(c, "sidecar", raw.sidecar);
  const runtime = { main: main !== null || raw.main !== undefined, sidecar: sidecar !== null || raw.sidecar !== undefined };
  if (runtime.main && runtime.sidecar) c.problems.push(t(`a plugin can declare main or sidecar, not both`));
  const contributes = contributesOf(c, raw[K], runtime.main);
  const given = activationEventsOf(c, raw.activationEvents);
  if (given && !runtime.main) c.problems.push(t(`activationEvents only go with a main`));
  const [alwaysOn, official, autoInstall] = (["alwaysOn", "official", "autoInstall"] as const).map((k) => (raw[k] === undefined ? false : raw[k] === true || (c.problems.push(`${k} must be true`), false)));
  const page = pageOf(contributes);
  v2OnlyProblems(c, raw, contributes.programs, declaredManifest);
  commandProblems(c, contributes, permissions, page !== null, runtime.main);
  contributionProblems(c, contributes, permissions, runtime);
  if (contributes.panels.some((p) => p.file) && name && RESERVED_PAGE_NAMES.includes(name)) c.problems.push(`name: ${name} is one of Ardia's own pages (ardia://${name}), so a plugin with a page can't use it`);
  if (sidecar && Array.isArray(permissions.network)) c.problems.push(t(`permissions.network: a sidecar can only have "*" or false, since Ardia can't hold a program to a list of hosts`));
  if (c.problems.length || !name || !title) return { manifest: null, problems: c.problems };
  const activationEvents = given ?? derivedActivationEvents(contributes, runtime);
  const k = contributes;
  return {
    manifest: {
      manifest: MANIFEST_VERSION, declaredManifest, name, title, description, version, requires, icon, keywords, telemetry, permissions, main, sidecar, activationEvents, contributes,
      alwaysOn: !!alwaysOn, official: !!official, autoInstall: !!autoInstall,
      settings: k.settings, commands: k.commands, tools: k.tools, hooks: k.hooks, programs: k.programs, passwordManager: k.passwordManager, page, process: sidecar,
    },
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
    return { manifest: null, problems: [t(`manifest must be a whole number, the manifest's version`)], newer: false };
  if (typeof given === "number" && given > MANIFEST_VERSION)
    return { manifest: null, problems: [`manifest ${given} needs a newer Ardia (this one reads up to ${MANIFEST_VERSION})`], newer: true };
  const current = upgraded(doc, MANIFEST_VERSION, MANIFEST_MIGRATIONS, "manifest");
  if (!current) return { manifest: null, problems: [`${MANIFEST_FILE} couldn't be read`], newer: false };
  const declared = typeof given === "number" ? given : 0;
  const legacy = declared < MANIFEST_VERSION;
  const { manifest, problems } = checkManifest(current, declared);
  return { manifest, problems: problems.map((p) => `${MANIFEST_FILE}: ${legacy ? v1Problem(p) : p}`), newer: false };
}

export type Contribution = "settings" | "commands" | "page" | "process" | "programs" | "hooks" | "tools" | "passwordManager" | "main" | "menus" | "toolbar" | "sidebarViews" | "panels" | "omnibox" | "themes";
export const CONTRIBUTIONS: readonly Contribution[] = ["settings", "commands", "page", "process", "programs", "hooks", "tools", "passwordManager", "main", "menus", "toolbar", "sidebarViews", "panels", "omnibox", "themes"];

export function contributionsOf(m: PluginManifest): Contribution[] {
  const k = m.contributes;
  const has: Record<Contribution, boolean> = {
    settings: Object.keys(k.settings.defaults).length > 0 || k.settings.rows.length > 0,
    commands: k.commands.length > 0,
    page: m.page !== null,
    process: m.sidecar !== null,
    programs: k.programs.length > 0,
    hooks: k.hooks.length > 0,
    tools: k.tools.length > 0,
    passwordManager: k.passwordManager !== null,
    main: m.main !== null,
    menus: MENU_SLOTS.some((slot) => k.menus[slot].length > 0),
    toolbar: k.toolbar.length > 0,
    sidebarViews: k.sidebarViews.length > 0,
    panels: k.panels.some((p) => p !== pagePanelOf(k.panels)),
    omnibox: k.omnibox.length > 0,
    themes: k.themes.length > 0,
  };
  return CONTRIBUTIONS.filter((c) => has[c]);
}

export function defaultValues(m: PluginManifest): Record<string, RowValue> {
  return Object.fromEntries(storedRows(m.settings).map((r) => [r.key, r.default]));
}

export const networkLabel = (p: PluginPermissions): string => (p.network === false ? "none" : p.network === ANY_HOST ? "any" : p.network.join(", "));
