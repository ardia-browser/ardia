import { BUILT_IN_ENGINES } from "@ardia/core";
import { JSON_SCHEMA_DIALECT, schemaJson, type JsonSchema } from "../../lib/jsonSchema";
import { themeSchema, type RolePalettes } from "../../lib/themeFile";
import { CONFIG_SETTING_KEYS } from "../settings/configAllowlist";
import { SETTING_SPECS } from "../settings/settings";
import { PER_PROFILE_SHORTCUT_PATTERN, SHORTCUT_FORMAT, shortcutCatalog, shortcutDescription } from "./configShortcuts";
import { launchActionIds, MAX_LAUNCH_ACTIONS } from "../automation/launchActions";
import { PLUGIN_EVENTS } from "../automation/eventNames";
import { PLUGIN_SCHEMA_FILE, pluginSchemaJson } from "../../lib/pluginSchema";
import { PLUGIN_RULES } from "../plugins/appChecks";

const CONFIG_SCHEMA_FILE = "config.schema.json";
const THEME_SCHEMA_FILE = "theme.schema.json";
const CONFIG_THEME_PATTERN = "^(?:[a-z0-9][a-z0-9_-]*|plugin:[a-z0-9][a-z0-9-]{0,39}/[A-Za-z0-9_-]{1,40})$";

function shortcutsSchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [id, entry] of shortcutCatalog()) properties[id] = { type: "string", description: shortcutDescription(entry) };
  return {
    type: "object",
    description: `Command id to shortcut, or switchProfile:<profile id> and newLittleArdia:<profile id> with the id from profiles.list. ${SHORTCUT_FORMAT} A command left out keeps what it has.`,
    properties,
    propertyNames: { anyOf: [{ enum: Object.keys(properties) }, { pattern: PER_PROFILE_SHORTCUT_PATTERN }] },
    additionalProperties: { type: "string", description: "A profile's own shortcut: switchProfile:<profile id> or newLittleArdia:<profile id>" },
    default: {},
  };
}

function settingSchema(key: (typeof CONFIG_SETTING_KEYS)[number]): JsonSchema {
  if (key === "shortcuts") return shortcutsSchema();
  if (key === "launchActions") {
    return {
      type: "array",
      items: { type: "string", enum: launchActionIds() },
      maxItems: MAX_LAUNCH_ACTIONS,
      default: [],
      description: "Commands Ardia runs in the focused window after it restores the session, like [\"newTab\"]. Command ids, or id:variant.",
    };
  }
  const spec = SETTING_SPECS[key];
  const schema: JsonSchema = { ...spec.schema, default: spec.default };
  if (key === "searchEngine") schema.description = `An engine id: ${BUILT_IN_ENGINES.map((e) => e.id).join(", ")}, or one added in Settings`;
  return schema;
}

export function configSchema(): object {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    description: "Ardia's config.json. Ardia applies it at launch and whenever it changes; it never writes it.",
    type: "object",
    properties: {
      $schema: { type: "string" },
      theme: { type: ["string", "null"], pattern: CONFIG_THEME_PATTERN, description: "A theme in themes/<name>.json, a plugin's theme as plugin:<plugin>/<theme>, or null for Ardia's own", default: null },
      settings: {
        type: "object",
        properties: Object.fromEntries(CONFIG_SETTING_KEYS.map((key) => [key, settingSchema(key)])),
        additionalProperties: false,
      },
    },
  };
}

export const schemaFiles = (roles: RolePalettes): Record<string, string> => ({
  [CONFIG_SCHEMA_FILE]: schemaJson(configSchema()),
  [THEME_SCHEMA_FILE]: schemaJson(themeSchema(roles)),
  [PLUGIN_SCHEMA_FILE]: pluginSchemaJson(PLUGIN_EVENTS, PLUGIN_RULES),
});
