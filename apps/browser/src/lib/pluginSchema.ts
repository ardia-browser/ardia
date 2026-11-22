import { JSON_SCHEMA_DIALECT, schemaJson, type JsonSchema } from "./jsonSchema";
import { RESERVED_PAGE_NAMES } from "./pluginNames";
import { DEFAULT_MAIN_MB, KEYWORD_PATTERN, LIMITS, VERSION_PATTERN } from "./pluginChecks";
import { SPLIT_SIDES } from "./pluginCommands";
import { MENU_SLOTS, PANEL_MODES } from "./pluginContributions";
import { TAB_ACCESS } from "./pluginPermissions";
import { MAX_WHEN_LENGTH } from "./pluginWhen";
import { builtInFlags, closed, commandBase, key, name, openCommandProperties, passwordManagerSchema, pluginPath, processSchema, programsSchemaV2, rowSchema, symbol, textOf, toolsSchema } from "./pluginSchemaParts";
import { legacyPluginBody } from "./pluginSchemaV1";
import { MANIFEST_VERSION } from "./pluginManifest";

export const PLUGIN_SCHEMA_FILE = "plugin.schema.json";

export type PluginRules = { untabbedEvents: readonly string[]; approvedSettings: readonly string[]; decideEvents?: readonly string[] };

const when: JsonSchema = { type: "string", pattern: `^[\\s\\S]{1,${MAX_WHEN_LENGTH}}$`, description: "Shows only when this holds, like urlHost == \"github.com\" && !isPinned" };
const list = (max: number, items: JsonSchema, description?: string): JsonSchema => ({ type: "array", maxItems: max, items, ...(description ? { description } : {}) });

const permissions = closed({
  tabs: { enum: [...TAB_ACCESS, false], description: "read: see your tabs. write: also open them" },
  fullUrls: { type: "boolean", description: "See whole addresses, with what follows ? and #" },
  activePage: { type: "boolean", description: "Read the text of the tab you're on, for 30 seconds after you use the plugin" },
  workspace: { type: "boolean", description: "See and rearrange every window, tab and group (needs tabs: write and fullUrls)" },
  commands: { type: "boolean", description: "Run Ardia commands" },
  storage: { type: "boolean", description: "Keep its own data" },
  secrets: { type: "boolean", description: "Keep secrets in the Keychain" },
  network: { anyOf: [{ const: false }, { const: "*" }, { type: "array", minItems: 1, maxItems: LIMITS.allowedHosts, items: { type: "string", pattern: "^(\\*\\.)?[a-z0-9.-]{1,253}$" } }], description: "false, \"*\" or hosts like api.example.com and *.example.com" },
  control: { type: "boolean", description: "Let programs you run drive your tabs and pages" },
});

const menuItem = closed({ command: name, title: textOf(LIMITS.title), icon: symbol, when }, ["command"]);

function contributes(hookNames: readonly string[]): JsonSchema {
  return closed({
    commands: list(
      LIMITS.commands,
      closed(
        {
          ...commandBase,
          ...openCommandProperties,
          when,
          view: { ...key, description: "Opens the command's view, which main renders" },
          panel: { ...key, description: "Opens one of the plugin's panels" },
          handler: { const: true, description: "main handles it; the default when there's a main and nothing else" },
        },
        ["name", "title"],
      ),
    ),
    tools: toolsSchema,
    hooks: list(LIMITS.hooks, { enum: [...hookNames] }),
    settings: closed({ defaults: { type: "object", description: "Ardia settings, as in config.json" }, rows: list(LIMITS.rows, rowSchema(["toggle", "text", "number", "choice", "secret"])) }),
    programs: programsSchemaV2,
    passwordManager: passwordManagerSchema,
    menus: closed(Object.fromEntries(MENU_SLOTS.map((slot) => [slot, list(LIMITS.menuItems, menuItem)]))),
    toolbar: list(LIMITS.toolbar, closed({ id: key, title: textOf(LIMITS.title), icon: symbol, command: name, view: key, tooltip: textOf(LIMITS.tooltip) }, ["id", "title", "icon"])),
    sidebarViews: list(LIMITS.sidebarViews, closed({ id: key, title: textOf(LIMITS.pageTitle), icon: symbol }, ["id", "title"])),
    panels: list(
      LIMITS.panels,
      closed({ id: key, title: textOf(LIMITS.pageTitle), icon: symbol, mode: { enum: [...PANEL_MODES] }, file: pluginPath("A page in the plugin's folder"), view: key, retainContext: { type: "boolean" }, side: { enum: [...SPLIT_SIDES] } }, ["id", "title", "mode"]),
    ),
    omnibox: list(LIMITS.omnibox, closed({ id: key, title: textOf(LIMITS.title), keyword: { type: "string", pattern: KEYWORD_PATTERN }, global: { type: "boolean", description: "Shows in every search; takes no keyword" } }, ["id", "title"])),
    themes: list(LIMITS.themes, closed({ id: key, title: textOf(LIMITS.title), file: { ...pluginPath("A theme file in the plugin's folder"), pattern: "^[^/\\\\][^\\\\]*\\.json$" } }, ["id", "title", "file"])),
  });
}

function pluginBody(eventNames: readonly string[], decideEvents: readonly string[]): JsonSchema {
  return closed(
    {
      $schema: { type: "string" },
      manifest: { const: MANIFEST_VERSION, description: "The manifest's version" },
      name: { ...name, description: "The plugin's name; its folder has the same name" },
      title: textOf(LIMITS.title),
      description: textOf(LIMITS.description),
      version: { type: "string", pattern: VERSION_PATTERN },
      requires: { type: "string", pattern: VERSION_PATTERN, description: "The first Ardia version the plugin works with" },
      icon: symbol,
      keywords: list(LIMITS.pluginKeywords, textOf(LIMITS.keyword), "Words that find the plugin in Settings"),
      telemetry: closed(
        { title: textOf(LIMITS.title), items: { type: "array", minItems: 1, maxItems: LIMITS.telemetryItems, items: textOf(LIMITS.telemetryItem) } },
        ["title", "items"],
      ),
      main: { ...pluginPath("The plugin's JavaScript, like dist/index.js; a plugin has main or sidecar, not both"), pattern: "^[^/\\\\][^\\\\]*\\.(m?js|cjs)$" },
      memoryMB: { type: "integer", minimum: LIMITS.memoryMB[0], maximum: LIMITS.memoryMB[1], default: DEFAULT_MAIN_MB, description: "main's memory limit" },
      sidecar: { ...processSchema, description: "A program Ardia runs beside the plugin; a plugin has main or sidecar, not both" },
      activationEvents: list(LIMITS.activationEvents, { type: "string", pattern: "^(\\*|onStartupFinished|on(Command|View|Panel|Toolbar|Omnibox|Menu|Event|Url):\\S{1,253})$" }, "When main starts; worked out from contributes when left out"),
      permissions,
      contributes: contributes([...eventNames, ...decideEvents]),
      ...builtInFlags,
    },
    ["manifest", "name"],
  );
}

export function pluginSchema(eventNames: readonly string[], rules: PluginRules): Record<string, unknown> {
  const decideEvents = rules.decideEvents ?? [];
  const appRules = { untabbedEvents: [...rules.untabbedEvents], approvedSettings: [...rules.approvedSettings], decideEvents: [...decideEvents], reservedPageNames: [...RESERVED_PAGE_NAMES] };
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: "Ardia plugin",
    type: "object",
    if: { properties: { manifest: { const: MANIFEST_VERSION } }, required: ["manifest"] },
    then: pluginBody(eventNames, decideEvents),
    else: legacyPluginBody(eventNames),
    "x-ardia-rules": appRules,
  };
}

export const pluginSchemaJson = (eventNames: readonly string[], rules: PluginRules) => schemaJson(pluginSchema(eventNames, rules));
