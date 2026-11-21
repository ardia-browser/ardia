import { JSON_SCHEMA_DIALECT, schemaJson, type JsonSchema } from "./jsonSchema";
import { RESERVED_PAGE_NAMES } from "./pluginNames";
import { PASSWORD_FIELD_COUNT, PASSWORD_FIELDS, PASSWORD_FILLS } from "./pluginPasswordManager";
import { BUTTON_DIVIDER, HOST_ACTION_NAMES, PAGE_BAR_LIMITS, PAGE_BAR_LOOKS } from "./pluginPageBar";
import { KEY_PATTERN, LIMITS, MANIFEST_VERSION, NAME_PATTERN, PLUGIN_PERMISSIONS, SPLIT_SIDES, SYMBOL_PATTERN, VERSION_PATTERN } from "./pluginManifest";

export const PLUGIN_SCHEMA_FILE = "plugin.schema.json";

const UNSAFE_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069";
const textOf = (max: number, description?: string): JsonSchema => ({ type: "string", pattern: `^(?=[\\s\\S]*\\S)[^${UNSAFE_CLASS}]{1,${max}}$`, ...(description ? { description } : {}) });
const closed = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
});
const name: JsonSchema = { type: "string", pattern: NAME_PATTERN };
const key: JsonSchema = { type: "string", pattern: KEY_PATTERN };
const symbol: JsonSchema = { type: "string", pattern: SYMBOL_PATTERN, description: "An SF Symbol name" };

const row = closed(
  {
    key,
    title: textOf(LIMITS.title),
    description: textOf(LIMITS.description),
    type: { enum: ["toggle", "text", "choice"] },
    default: { type: ["boolean", "string"] },
    choices: { type: "array", minItems: LIMITS.choices[0], maxItems: LIMITS.choices[1], items: closed({ value: key, title: textOf(LIMITS.title) }, ["value", "title"]) },
  },
  ["key", "title", "type", "default"],
);

export type PluginRules = { untabbedEvents: readonly string[]; approvedSettings: readonly string[] };

export function pluginSchema(eventNames: readonly string[], rules: PluginRules): Record<string, unknown> {
  const body: JsonSchema = closed(
    {
      $schema: { type: "string" },
      manifest: { type: "integer", minimum: 0, maximum: MANIFEST_VERSION, default: MANIFEST_VERSION, description: "The manifest's version" },
      name: { ...name, description: "The plugin's name; its folder has the same name" },
      title: textOf(LIMITS.title),
      description: textOf(LIMITS.description),
      version: { type: "string", pattern: VERSION_PATTERN },
      requires: { type: "string", pattern: VERSION_PATTERN, description: "The first Ardia version the plugin works with" },
      permissions: { type: "array", maxItems: PLUGIN_PERMISSIONS.length, items: { enum: [...PLUGIN_PERMISSIONS] } },
      settings: {
        ...closed({ defaults: { type: "object", description: "Ardia settings, as in config.json" }, rows: { type: "array", maxItems: LIMITS.rows, items: row } }),
        description: "Version 1: defaults and rows. A file without manifest (version 0) gives Ardia settings here directly.",
      },
      commands: {
        type: "array",
        maxItems: LIMITS.commands,
        items: closed(
          {
            name,
            title: textOf(LIMITS.title),
            icon: symbol,
            keywords: { type: "array", maxItems: LIMITS.keywords, items: textOf(LIMITS.keyword) },
            tool: name,
            input: { type: "object" },
            open: { enum: ["tab", "split"], description: "Open the plugin's page as a tab, or in Split View beside the current tab" },
            context: { type: "boolean", description: "Hand the page the current tab (needs the tabs permission)" },
            side: { enum: [...SPLIT_SIDES], default: "right" },
            sideSetting: { ...key, description: "A choice row whose value picks the side" },
            path: { type: "string", pattern: "^(/[^?#\\s]*)?(\\?[^#\\s]*)?$", description: "Where in the plugin's page to open, like /history" },
          },
          ["name", "title"],
        ),
      },
      page: closed({ title: textOf(LIMITS.pageTitle), icon: symbol, file: { type: "string", pattern: "^[^/\\\\][^\\\\]*$" } }, ["title", "file"]),
      process: closed(
        {
          run: { type: "array", minItems: 1, maxItems: LIMITS.argv, items: { type: "string", pattern: "^[^\\u0000]{1,1024}$" } },
          memoryMB: { type: "integer", minimum: LIMITS.memoryMB[0], maximum: LIMITS.memoryMB[1], default: 1024 },
        },
        ["run"],
      ),
      programs: {
        type: "array",
        maxItems: LIMITS.programs,
        description: "Commands Ardia puts on your PATH while the plugin is on",
        items: closed(
          {
            name: { ...name, description: "The command's name on PATH" },
            path: { type: "string", pattern: "^[^/\\\\][^\\\\]*$", description: "An executable file in the plugin's folder, like bin/tool" },
            afterUpdate: {
              type: "array",
              maxItems: LIMITS.afterUpdate[0],
              items: { type: "array", minItems: 1, maxItems: LIMITS.afterUpdate[1], items: { type: "string", pattern: "^[^\\u0000]{1,1024}$" } },
              description: "Built-in plugins only: argument lists Ardia runs the program with, once per new version",
            },
          },
          ["name", "path"],
        ),
      },
      passwordManager: {
        ...closed(
          {
            fill: { enum: [...PASSWORD_FILLS], description: "system: macOS's Passwords panel fills the field. tool is reserved and refused for now" },
            fields: { type: "array", minItems: PASSWORD_FIELD_COUNT[0], maxItems: PASSWORD_FIELD_COUNT[1], uniqueItems: true, items: { enum: [...PASSWORD_FIELDS] } },
            verificationCodeSetup: { enum: ["system"], description: "Offer to set up two-factor codes a page shows in the app macOS uses for otpauth links" },
            passkeys: { enum: ["system"], description: "Show the host's passkey status on the plugin's Settings page" },
          },
          ["fill", "fields"],
        ),
        description: "Makes the plugin a password manager each profile can pick in Settings › Profiles › Passwords",
      },
      siteSwitches: {
        type: "array",
        maxItems: PAGE_BAR_LIMITS.siteSwitches,
        description: "Switches Site Controls shows for each http(s) site, kept per origin on this device",
        items: closed({ key, title: textOf(PAGE_BAR_LIMITS.switchTitle), icon: symbol }, ["key", "title"]),
      },
      pageBar: {
        ...closed(
          {
            look: { enum: [...PAGE_BAR_LOOKS], description: "stripes: Arc's striped developer bar above the page, or in the toolbar's address field" },
            when: {
              ...closed(
                {
                  siteSwitch: { ...key, description: "One of this plugin's siteSwitches: the bar shows on sites where it is on" },
                  localAddresses: { ...key, description: "A toggle row: while it is on, a local address typed in the address bar turns siteSwitch on for that site" },
                },
                ["siteSwitch"],
              ),
            },
            buttons: { type: "array", minItems: 1, maxItems: PAGE_BAR_LIMITS.buttons, items: { enum: [...HOST_ACTION_NAMES, BUTTON_DIVIDER] }, description: `Host actions in order; ${BUTTON_DIVIDER} is a divider` },
          },
          ["look", "when", "buttons"],
        ),
        description: "A bar Ardia draws above the pages the plugin's site switch is on for, with buttons that run Ardia's own actions on that tab",
      },
      alwaysOn: { const: true, description: "Built-in plugins only: once installed, no switch turns it off" },
      official: { const: true, description: "Built-in plugins only: listed among Ardia's official plugins" },
      autoInstall: { const: true, description: "Built-in plugins only, with alwaysOn: installed on a new profile with no click" },
      icon: symbol,
      hooks: { type: "array", maxItems: 64, items: { enum: [...eventNames] } },
      tools: {
        type: "array",
        maxItems: LIMITS.tools,
        items: closed(
          { name, title: textOf(LIMITS.title), description: textOf(LIMITS.description), timeout: { type: "integer", minimum: LIMITS.toolTimeout[0], maximum: LIMITS.toolTimeout[1], default: 30 } },
          ["name", "title"],
        ),
      },
    },
    ["name"],
  );
  const appRules = { untabbedEvents: [...rules.untabbedEvents], approvedSettings: [...rules.approvedSettings], reservedPageNames: [...RESERVED_PAGE_NAMES] };
  return { $schema: JSON_SCHEMA_DIALECT, title: "Ardia plugin", ...body, "x-ardia-rules": appRules };
}

export const pluginSchemaJson = (eventNames: readonly string[], rules: PluginRules) => schemaJson(pluginSchema(eventNames, rules));
