import { isFields, type Fields } from "./decode";
import { validateManifestV3, type ManifestV3 } from "@ardia/plugin-sdk/manifest";
import { RESERVED_PAGE_NAMES } from "./pluginNames";
import { LIMITS, matching, text, type Check } from "./pluginChecks";
import { SPLIT_SIDES, type CommandSpec } from "./pluginCommands";
import { contributesOf, MENU_SLOTS, pagePanelOf, type PluginContributions } from "./pluginContributions";
import { activationEventsOf, derivedActivationEvents, ACTIVATION_PREFIXES } from "./pluginActivation";
import { permissionsOf, type PluginPermissions } from "./pluginPermissions";
import { storedRows, type RowValue, type SettingsSpec } from "./pluginRows";
import { mainOf, sidecarOf, type MainSpec, type ProcessSpec, type ProgramSpec } from "./pluginRuntime";
import type { PasswordManagerSpec } from "./pluginPasswordManager";
import { STATE_INTENTS, STATE_TOPICS } from "./pluginState";
import { isOfficialId, keyOfId, PLUGIN_KEY, splitPluginId } from "./pluginIds";

export { compareVersions } from "./versions";
export { LIMITS, NAME_PATTERN, KEY_PATTERN, VERSION_PATTERN, SYMBOL_PATTERN, KEYWORD_PATTERN, isPluginPath, DEFAULT_MAIN_MB, DEFAULT_SIDECAR_MB } from "./pluginChecks";
export { ROW_TYPES, rowValue, storedRows, secretRows, type RowSpec, type RowType, type RowValue, type SettingsSpec } from "./pluginRows";
export { SPLIT_SIDES, isToolAction, isOpenAction, isViewAction, isPanelAction, isHandlerAction, type PageSide, type CommandAction, type CommandSpec, type ToolSpec } from "./pluginCommands";
export { PLUGIN_PERMISSIONS, PERMISSION_KEYS, NO_PERMISSIONS, TAB_ACCESS, grantedPermissions, missingPermissions, canReadTabs, canOpenTabs, hasNetwork, allowedHostsOf, type PluginPermission, type PluginPermissions, type PermissionKey, type TabAccess, type NetworkAccess } from "./pluginPermissions";
export { MENU_SLOTS, PANEL_MODES, PAGE_PANEL_ID, CONTRIBUTES_KEYS, pagePanelOf, viewIdsOf, type MenuSlot, type PanelMode, type MenuContribution, type MenuContributions, type ToolbarItem, type SidebarView, type PanelSpec, type OmniboxSpec, type ThemeSpec, type PluginContributions } from "./pluginContributions";
export { STARTUP_EVENTS, ACTIVATION_PREFIXES, activationEventProblem, derivedActivationEvents, startsEagerly, urlActivationHosts } from "./pluginActivation";
export type { MainSpec, ProcessSpec, ProgramSpec } from "./pluginRuntime";
export type { ManifestV3 } from "@ardia/plugin-sdk/manifest";

export const MANIFEST_VERSION = 3;
const MANIFEST_FILE = "plugin.json";

type PageSpec = { title: string; icon: string; source: { file: string } };
type TelemetryDisclosure = { title: string; items: string[] };

export type PluginScope = "global" | "profile";

export type PluginManifest = {
  manifest: number;
  id: string;
  scope: PluginScope;
  name: string;
  title: string;
  description: string;
  version: string;
  engines: { ardia: string; sdk?: string };
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  provides: string[];
  consumes: string[];
  categories: string[];
  icon: string | null;
  keywords: string[];
  telemetry: TelemetryDisclosure | null;
  permissions: PluginPermissions;
  main: MainSpec | null;
  sidecar: ProcessSpec | null;
  activationEvents: string[];
  contributes: PluginContributions;
  official: boolean;
  settings: SettingsSpec;
  commands: CommandSpec[];
  tools: PluginContributions["tools"];
  hooks: string[];
  programs: ProgramSpec[];
  passwordManager: PasswordManagerSpec | null;
  page: PageSpec | null;
  process: ProcessSpec | null;
  v3: ManifestV3;
};

export type ManifestRead = { manifest: PluginManifest | null; problems: string[]; newer: boolean };

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
  const needsRuntime: [string, boolean][] = [["tool commands", k.commands.some((x) => "tool" in x.action)], ["tools", k.tools.length > 0], ["hooks", k.hooks.length > 0]];
  for (const [what, used] of needsRuntime) if (used && !runtime.main && !runtime.sidecar) c.problems.push(`${what} needs a main or a sidecar`);
  if (k.settings.rows.some((r) => r.type === "secret") && !permissions.secrets) c.problems.push(`${K}.settings.rows: a secret row needs the secrets permission`);
}

function pageOf(k: PluginContributions): PageSpec | null {
  const panel = pagePanelOf(k.panels);
  return panel?.file ? { title: panel.title, icon: panel.icon, source: { file: panel.file } } : null;
}

const V2_HOST = /^(\*\.)?[a-z0-9.-]{1,253}$/;

function runtimePermissions(p: ManifestV3["permissions"]): Fields {
  if (!p) return {};
  const active = p.activePage === true || (isFields(p.activePage) && p.activePage.read === true);
  const hosts = Array.isArray(p.network) ? p.network.filter((h) => V2_HOST.test(h)) : [];
  const network = p.network === "*" ? "*" : hosts.length ? hosts : false;
  const state = isFields(p.state)
    ? {
        events: (p.state.events ?? []).filter((e) => (STATE_TOPICS as readonly string[]).includes(e)),
        intents: (p.state.intents ?? []).filter((i) => (STATE_INTENTS as readonly string[]).includes(i)),
      }
    : false;
  const out: Fields = { tabs: p.tabs ?? false, network, state };
  for (const key of ["fullUrls", "workspace", "commands", "storage", "secrets", "control"] as const) if (p[key] !== undefined) out[key] = p[key];
  if (active) out.activePage = true;
  return out;
}

const RUNTIME_CONTRIBUTES = ["commands", "tools", "hooks", "settings", "programs", "passwordManager", "toolbar", "sidebarViews", "panels", "omnibox", "themes", "siteSwitches", "pageBar"] as const;

function runtimeContributes(c: ManifestV3["contributes"]): Fields {
  if (!c) return {};
  const out: Fields = {};
  for (const key of RUNTIME_CONTRIBUTES) if (c[key] !== undefined) out[key] = c[key];
  if (c.commands) out.commands = c.commands.map(({ inputMode: _inputMode, ...rest }) => rest);
  if (c.menus) out.menus = Object.fromEntries(MENU_SLOTS.flatMap((slot) => (c.menus?.[slot] ? [[slot, c.menus[slot]]] : [])));
  return out;
}

const runtimeActivation = (events: readonly string[] | undefined): string[] | undefined =>
  events?.filter((e) => e === "*" || e === "onStartupFinished" || ACTIVATION_PREFIXES.some((prefix) => e.startsWith(`${prefix}:`)));

function runtimeDoc(v3: ManifestV3, key: string): Fields {
  const doc: Fields = {
    name: key,
    title: v3.name,
    description: v3.description,
    version: v3.version,
    permissions: runtimePermissions(v3.permissions),
    contributes: runtimeContributes(v3.contributes),
  };
  if (v3.icon !== undefined) doc.icon = v3.icon;
  if (v3.keywords !== undefined) doc.keywords = v3.keywords;
  if (v3.telemetry !== undefined) doc.telemetry = v3.telemetry;
  if (v3.main !== undefined) doc.main = v3.main;
  if (v3.memoryMB !== undefined && v3.main !== undefined) doc.memoryMB = v3.memoryMB;
  if (v3.sidecar !== undefined && v3.main === undefined) doc.sidecar = v3.sidecar;
  const activation = runtimeActivation(v3.activationEvents);
  if (activation?.length) doc.activationEvents = activation;
  return doc;
}

function keywordsOf(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((k): k is string => typeof k === "string"))].slice(0, LIMITS.pluginKeywords) : [];
}

function checkRuntime(raw: Fields, v3: ManifestV3): { manifest: PluginManifest | null; problems: string[] } {
  const c: Check = { problems: [] };
  const name = matching(c, "id", raw.name, PLUGIN_KEY, "a plugin key like scope__name");
  const title = text(c, "name", raw.title, LIMITS.title);
  const permissions = permissionsOf(c, raw.permissions);
  const main = mainOf(c, raw.main, raw.memoryMB);
  const sidecar = sidecarOf(c, "sidecar", raw.sidecar);
  const runtime = { main: main !== null || raw.main !== undefined, sidecar: sidecar !== null || raw.sidecar !== undefined };
  const contributes = contributesOf(c, raw[K], runtime.main);
  const given = activationEventsOf(c, raw.activationEvents);
  const page = pageOf(contributes);
  commandProblems(c, contributes, permissions, page !== null, runtime.main);
  contributionProblems(c, contributes, permissions, runtime);
  if (contributes.panels.some((p) => p.file) && name && RESERVED_PAGE_NAMES.includes(name)) c.problems.push(`id: ${v3.id} is one of Ardia's own pages (ardia://${name}), so a plugin with a page can't use it`);
  if (sidecar && Array.isArray(permissions.network)) c.problems.push(`permissions.network: a sidecar can only have "*" or false, since Ardia can't hold a program to a list of hosts`);
  if (c.problems.length || !name || !title) return { manifest: null, problems: c.problems };
  const activationEvents = given ?? derivedActivationEvents(contributes, runtime);
  const k = contributes;
  const telemetry = isFields(raw.telemetry) && typeof raw.telemetry.title === "string" && Array.isArray(raw.telemetry.items) ? { title: raw.telemetry.title, items: raw.telemetry.items.filter((i): i is string => typeof i === "string") } : null;
  return {
    manifest: {
      manifest: MANIFEST_VERSION,
      id: v3.id,
      scope: v3.scope ?? "profile",
      name,
      title,
      description: v3.description,
      version: v3.version,
      engines: { ardia: v3.engines.ardia, ...(v3.engines.sdk ? { sdk: v3.engines.sdk } : {}) },
      dependencies: { ...(v3.dependencies ?? {}) },
      optionalDependencies: { ...(v3.optionalDependencies ?? {}) },
      provides: [...(v3.provides ?? [])],
      consumes: [...(v3.consumes ?? [])],
      categories: [...(v3.categories ?? [])],
      icon: v3.icon ?? null,
      keywords: keywordsOf(raw.keywords),
      telemetry,
      permissions,
      main,
      sidecar,
      activationEvents,
      contributes,
      official: isOfficialId(v3.id),
      settings: k.settings,
      commands: k.commands,
      tools: k.tools,
      hooks: k.hooks,
      programs: k.programs,
      passwordManager: k.passwordManager,
      page,
      process: sidecar,
      v3,
    },
    problems: [],
  };
}

export const OLDER_MANIFEST = "plugin.json uses an older manifest that this Ardia no longer reads; it needs manifest 3, with an id like @you/name (run npx ardia-plugin check)";

export function readManifest(text: string, key?: string): ManifestRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { manifest: null, problems: [`${MANIFEST_FILE} isn't valid JSON (${(error as Error).message})`], newer: false };
  }
  if (!isFields(doc)) return { manifest: null, problems: [`${MANIFEST_FILE} must be an object`], newer: false };
  const given = doc.manifest;
  if (given !== undefined && (typeof given !== "number" || !Number.isSafeInteger(given) || given < 0))
    return { manifest: null, problems: [`${MANIFEST_FILE}: manifest must be a whole number, the manifest's version`], newer: false };
  if (typeof given === "number" && given > MANIFEST_VERSION)
    return { manifest: null, problems: [`${MANIFEST_FILE}: manifest ${given} needs a newer Ardia (this one reads ${MANIFEST_VERSION})`], newer: true };
  if (given !== MANIFEST_VERSION) return { manifest: null, problems: [OLDER_MANIFEST], newer: false };
  const checked = validateManifestV3(doc);
  if (!checked.ok) return { manifest: null, problems: checked.problems.map((p) => `${MANIFEST_FILE}: ${p}`), newer: false };
  const runtimeKey = key ?? keyOfId(checked.manifest.id);
  if (!runtimeKey || !splitPluginId(checked.manifest.id)) return { manifest: null, problems: [`${MANIFEST_FILE}: id isn't a scoped plugin id`], newer: false };
  const { manifest, problems } = checkRuntime(runtimeDoc(checked.manifest, runtimeKey), checked.manifest);
  return { manifest, problems: problems.map((p) => `${MANIFEST_FILE}: ${p}`), newer: false };
}

export type Contribution = "settings" | "commands" | "page" | "process" | "programs" | "hooks" | "tools" | "passwordManager" | "main" | "menus" | "toolbar" | "sidebarViews" | "panels" | "omnibox" | "themes" | "siteSwitches" | "pageBar";
export const CONTRIBUTIONS: readonly Contribution[] = ["settings", "commands", "page", "process", "programs", "hooks", "tools", "passwordManager", "main", "menus", "toolbar", "sidebarViews", "panels", "omnibox", "themes", "siteSwitches", "pageBar"];

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
    siteSwitches: k.siteSwitches.length > 0,
    pageBar: k.pageBar !== null,
  };
  return CONTRIBUTIONS.filter((c) => has[c]);
}

export function defaultValues(m: PluginManifest): Record<string, RowValue> {
  return Object.fromEntries(storedRows(m.settings).map((r) => [r.key, r.default]));
}
