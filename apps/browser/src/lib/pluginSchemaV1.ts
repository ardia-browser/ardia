import type { JsonSchema } from "./jsonSchema";
import { LIMITS, VERSION_PATTERN } from "./pluginChecks";
import { PLUGIN_PERMISSIONS } from "./pluginPermissions";
import { builtInFlags, closed, commandBase, name, openCommandProperties, passwordManagerSchema, pluginPath, processSchema, programsSchema, rowSchema, symbol, textOf, toolsSchema } from "./pluginSchemaParts";
import { t } from "./uiLanguage";


export function legacyPluginBody(eventNames: readonly string[]): JsonSchema {
  return closed(
    {
      $schema: { type: "string" },
      manifest: { type: "integer", minimum: 0, maximum: 1, description: t(`Version 1 manifests still load; Ardia reads them as version 2`) },
      name: { ...name, description: t(`The plugin's name; its folder has the same name`) },
      title: textOf(LIMITS.title),
      description: textOf(LIMITS.description),
      version: { type: "string", pattern: VERSION_PATTERN },
      requires: { type: "string", pattern: VERSION_PATTERN, description: t(`The first Ardia version the plugin works with`) },
      permissions: { type: "array", maxItems: PLUGIN_PERMISSIONS.length, items: { enum: [...PLUGIN_PERMISSIONS] } },
      settings: {
        ...closed({ defaults: { type: "object", description: t(`Ardia settings, as in config.json`) }, rows: { type: "array", maxItems: LIMITS.rows, items: rowSchema(["toggle", "text", "choice"]) } }),
        description: t(`Version 1: defaults and rows. A file without manifest (version 0) gives Ardia settings here directly.`),
      },
      commands: { type: "array", maxItems: LIMITS.commands, items: closed({ ...commandBase, ...openCommandProperties }, ["name", "title"]) },
      page: closed({ title: textOf(LIMITS.pageTitle), icon: symbol, file: pluginPath() }, ["title", "file"]),
      process: processSchema,
      programs: programsSchema,
      passwordManager: passwordManagerSchema,
      ...builtInFlags,
      icon: symbol,
      hooks: { type: "array", maxItems: LIMITS.hooks, items: { enum: [...eventNames] } },
      tools: toolsSchema,
    },
    ["name"],
  );
}
