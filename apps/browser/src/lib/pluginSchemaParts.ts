import type { JsonSchema } from "./jsonSchema";
import { DEFAULT_SIDECAR_MB, KEY_PATTERN, LIMITS, NAME_PATTERN, SYMBOL_PATTERN } from "./pluginChecks";
import { SPLIT_SIDES } from "./pluginCommands";
import { PASSWORD_FIELD_COUNT, PASSWORD_FIELDS, PASSWORD_FILLS } from "./pluginPasswordManager";
import { t } from "./uiLanguage";


const UNSAFE_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069";
export const textOf = (max: number, description?: string): JsonSchema => ({ type: "string", pattern: `^(?=[\\s\\S]*\\S)[^${UNSAFE_CLASS}]{1,${max}}$`, ...(description ? { description } : {}) });
export const closed = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
});
export const name: JsonSchema = { type: "string", pattern: NAME_PATTERN };
export const key: JsonSchema = { type: "string", pattern: KEY_PATTERN };
export const symbol: JsonSchema = { type: "string", pattern: SYMBOL_PATTERN, description: t(`An SF Symbol name`) };
export const pluginPath = (description?: string): JsonSchema => ({ type: "string", pattern: "^[^/\\\\][^\\\\]*$", ...(description ? { description } : {}) });
const argument: JsonSchema = { type: "string", pattern: "^[^\\u0000]{1,1024}$" };

export function rowSchema(types: readonly string[]): JsonSchema {
  const numbers = types.includes("number");
  return closed(
    {
      key,
      title: textOf(LIMITS.title),
      description: textOf(LIMITS.description),
      type: { enum: [...types] },
      default: { type: numbers ? ["boolean", "string", "number"] : ["boolean", "string"] },
      choices: { type: "array", minItems: LIMITS.choices[0], maxItems: LIMITS.choices[1], items: closed({ value: key, title: textOf(LIMITS.title) }, ["value", "title"]) },
      ...(numbers ? { min: { type: "number" }, max: { type: "number" }, step: { type: "number", exclusiveMinimum: 0 }, placeholder: textOf(LIMITS.title) } : {}),
    },
    numbers ? ["key", "title", "type"] : ["key", "title", "type", "default"],
  );
}

export const openCommandProperties: Record<string, JsonSchema> = {
  open: { enum: ["tab", "split"], description: t(`Open the plugin's page as a tab, or in Split View beside the current tab`) },
  context: { type: "boolean", description: t(`Hand the page the current tab (needs the tabs permission)`) },
  side: { enum: [...SPLIT_SIDES], default: "right" },
  sideSetting: { ...key, description: t(`A choice row whose value picks the side`) },
  path: { type: "string", pattern: t(`^(/[^?#\\s]*)?(\\?[^#\\s]*)?$`), description: t(`Where in the plugin's page to open, like /history`) },
};

export const commandBase: Record<string, JsonSchema> = {
  name,
  title: textOf(LIMITS.title),
  icon: symbol,
  keywords: { type: "array", maxItems: LIMITS.keywords, items: textOf(LIMITS.keyword) },
  tool: name,
  input: { type: "object" },
};

export const processSchema = closed(
  {
    run: { type: "array", minItems: 1, maxItems: LIMITS.argv, items: argument },
    memoryMB: { type: "integer", minimum: LIMITS.memoryMB[0], maximum: LIMITS.memoryMB[1], default: DEFAULT_SIDECAR_MB },
  },
  ["run"],
);

export const programsSchema: JsonSchema = {
  type: "array",
  maxItems: LIMITS.programs,
  description: t(`Commands Ardia puts on your PATH while the plugin is on`),
  items: closed(
    {
      name: { ...name, description: t(`The command's name on PATH`) },
      path: pluginPath(t(`An executable file in the plugin's folder, like bin/tool`)),
      afterUpdate: {
        type: "array",
        maxItems: LIMITS.afterUpdate[0],
        items: { type: "array", minItems: 1, maxItems: LIMITS.afterUpdate[1], items: argument },
        description: t(`Built-in plugins only: argument lists Ardia runs the program with, once per new version`),
      },
    },
    ["name", "path"],
  ),
};

export const passwordManagerSchema: JsonSchema = {
  ...closed(
    {
      fill: { enum: [...PASSWORD_FILLS], description: t(`system: macOS's Passwords panel fills the field. tool is reserved and refused for now`) },
      fields: { type: "array", minItems: PASSWORD_FIELD_COUNT[0], maxItems: PASSWORD_FIELD_COUNT[1], uniqueItems: true, items: { enum: [...PASSWORD_FIELDS] } },
      verificationCodeSetup: { enum: ["system"], description: t(`Offer to set up two-factor codes a page shows in the app macOS uses for otpauth links`) },
      passkeys: { enum: ["system"], description: t(`Show the host's passkey status on the plugin's Settings page`) },
    },
    ["fill", "fields"],
  ),
  description: t(`Makes the plugin a password manager each profile can pick in Settings › Profiles › Passwords`),
};

export const programsSchemaV2: JsonSchema = {
  ...programsSchema,
  items: closed(
    {
      ...((programsSchema.items as JsonSchema).properties ?? {}),
      example: { ...textOf(LIMITS.example), description: t(`A command to try, shown once the program is on PATH, like ardia tabs`) },
      claim: { const: true, description: t(`Built-in plugins only: reserves the name, so no other plugin can put a program with it on PATH`) },
    },
    ["name", "path"],
  ),
};

export const toolsSchema: JsonSchema = {
  type: "array",
  maxItems: LIMITS.tools,
  items: closed(
    { name, title: textOf(LIMITS.title), description: textOf(LIMITS.description), timeout: { type: "integer", minimum: LIMITS.toolTimeout[0], maximum: LIMITS.toolTimeout[1], default: 30 } },
    ["name", "title"],
  ),
};

export const builtInFlags: Record<string, JsonSchema> = {
  alwaysOn: { const: true, description: t(`Built-in plugins only: once installed, no switch turns it off`) },
  official: { const: true, description: t(`Built-in plugins only: listed among Ardia's official plugins`) },
  autoInstall: { const: true, description: t(`Built-in plugins only, with alwaysOn: installed on a new profile with no click`) },
};
