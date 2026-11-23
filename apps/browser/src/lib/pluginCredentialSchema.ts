import type { JsonSchema } from "./jsonSchema";
import { KEY_PATTERN } from "./pluginChecks";
import { closed, key, pluginPath, symbol, textOf } from "./pluginSchemaParts";

const CAPABILITIES = ["totp", "save", "edit", "addTotp", "passkeys", "selfHosted", "masterPassword", "touchID"];
const SLOT_TYPES = ["id", "enum", "flag", "url", "email", "code", "secret", "json"];
const OUTPUT_MODES = ["json", "lines", "lastLineSecret", "stream"];
const ENV_NAME = "^[A-Z][A-Z0-9_]{0,63}$";
const VERB_ID = "^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*){0,3}$";
const PLAIN_TOKEN = "^[^\\s\\u0000-\\u001f\\u007f]{1,256}$";
const LONG_OPTION = "^--[a-z][a-z0-9-]{0,40}$";
const bool: JsonSchema = { type: "boolean" };
const keyMap = (value: JsonSchema, keyPattern = KEY_PATTERN): JsonSchema => ({ type: "object", propertyNames: { pattern: keyPattern }, additionalProperties: value });
const upTo = (most: number): JsonSchema => ({ type: "string", pattern: `^[\\s\\S]{0,${most}}$` });

const field = closed(
  {
    id: key,
    title: textOf(40),
    type: { enum: ["text", "email", "secret"], description: "secret: Ardia's native secure field; the plugin gets a single-use handle, never the text" },
    placeholder: textOf(60),
    hint: textOf(120),
    optional: bool,
    prefill: { const: "account", description: "The provider's last known account" },
    masked: { ...bool, description: "secret only: false shows what's typed, on the same native path" },
  },
  ["id", "title", "type"],
);

const method = closed(
  {
    id: key,
    title: textOf(40),
    kind: { enum: ["fields", "desktopApproval", "browserApproval"], default: "fields" },
    fields: { type: "array", maxItems: 6, items: field },
    twoStep: { ...bool, description: "fields only: the provider may ask for a two-step code" },
    appURL: { type: "string", pattern: "^[a-z][a-z0-9+.-]{1,30}://$", description: "desktopApproval: the app's address, like onepassword://" },
    appTitle: textOf(40, "desktopApproval: the app's name"),
  },
  ["id", "title"],
);

const server = closed({ id: key, title: textOf(40), custom: closed({ title: textOf(40), placeholder: textOf(60) }, ["title"]) }, ["id", "title"]);

const signIn = closed(
  {
    methods: { type: "array", minItems: 1, maxItems: 4, items: method },
    servers: { type: "array", maxItems: 6, items: server },
    unlock: closed({ field: { ...key, description: "A secret field of a method, asked for again to unlock" } }, ["field"]),
    approvalHosts: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", pattern: "^[a-z0-9.-]{1,253}$" }, description: "Hosts (and their subdomains) whose https pages Ardia may open for an approval" },
  },
  ["methods"],
);

const envEntry: JsonSchema = {
  anyOf: [
    closed({ name: { type: "string", pattern: ENV_NAME }, literal: upTo(256) }, ["name", "literal"]),
    closed({ name: { type: "string", pattern: ENV_NAME }, secretSlot: key }, ["name", "secretSlot"]),
    closed({ name: { type: "string", pattern: ENV_NAME }, testFolder: upTo(64) }, ["name", "testFolder"]),
    closed({ name: { type: "string", pattern: ENV_NAME }, testLiteral: upTo(256) }, ["name", "testLiteral"]),
  ],
};

const argvToken: JsonSchema = {
  anyOf: [
    { type: "string", pattern: "^(?!--$)[^\\s\\u0000-\\u001f\\u007f]{1,256}$" },
    closed({ slot: key }, ["slot"]),
    closed({ flag: { type: "string", pattern: LONG_OPTION }, slot: key }, ["flag", "slot"]),
    closed({ flag: { type: "string", pattern: LONG_OPTION }, when: key }, ["flag", "when"]),
  ],
};

const slot = closed(
  {
    type: { enum: SLOT_TYPES },
    optional: bool,
    pattern: { ...key, description: "id: one of cli.patterns" },
    values: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", pattern: "^[^-\\s][^\\s]{0,63}$" } },
    allowLocalHttp: { ...bool, description: "url: also take http for localhost, 127.0.0.1 and ::1" },
  },
  ["type"],
);

const verb = closed({
  argv: { type: "array", minItems: 1, maxItems: 32, items: argvToken, prefixItems: [{ type: "string", pattern: PLAIN_TOKEN }] },
  slots: keyMap(slot),
  env: { type: "array", maxItems: 16, items: envEntry },
  stdin: closed({ slot: key, encoding: { enum: ["utf8", "base64"], default: "utf8" } }, ["slot"]),
  timeoutMs: { type: "integer", minimum: 1000, maximum: 900000, default: 30000 },
  outputLimitBytes: { type: "integer", minimum: 1024, maximum: 167772160, default: 33554432 },
  output: closed({ mode: { enum: OUTPUT_MODES }, items: { type: "string", pattern: `^(\\$|${KEY_PATTERN.slice(1, -1)})$` } }, ["mode"]),
  signIn: bool,
  unlocks: { anyOf: [bool, closed({ persistent: bool }, ["persistent"])] },
  outlivesCall: bool,
  hints: keyMap({ type: "array", minItems: 1, maxItems: 16, items: { type: "string", pattern: "^[\\s\\S]{1,120}$" } }),
}, ["argv", "output"]);

const lockSource: JsonSchema = {
  anyOf: [closed({ from: { const: "session" } }, ["from"]), closed({ from: { const: "preference" }, key }, ["from", "key"]), closed({ literal: upTo(256) }, ["literal"])],
};

const cli = closed(
  {
    name: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,31}$", description: "A bare program name, found by Ardia's trusted locator" },
    install: closed({ command: textOf(200), update: textOf(200), url: { type: "string", pattern: "^https://[^\\s]{1,2040}$" } }, ["command"]),
    minimumVersion: { type: "string", pattern: "^\\d{1,6}(\\.\\d{1,6}){1,3}$" },
    patterns: keyMap({ type: "string", pattern: "^\\^[\\s\\S]{0,198}\\$$" }),
    env: { type: "array", maxItems: 16, items: envEntry },
    onLock: closed({ verb: { type: "string", pattern: VERB_ID }, params: keyMap(lockSource), skipWithTouchID: bool }, ["verb"]),
    verbs: keyMap(verb, VERB_ID),
  },
  ["name", "install", "verbs"],
);

export const credentialProviderSchema: JsonSchema = {
  ...closed(
    {
      title: textOf(40),
      symbol: { ...symbol, default: "key.fill" },
      icon: { ...pluginPath("A .png in the plugin's folder, at most 1 MB"), pattern: "^[^/\\\\][^\\\\]*\\.png$" },
      accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
      readsOffline: { ...bool, default: true },
      approvalLastsSeconds: { type: "integer", minimum: 1, maximum: 86400 },
      capabilities: { type: "array", maxItems: 8, uniqueItems: true, items: { enum: CAPABILITIES } },
      signIn,
      cli,
    },
    ["title", "signIn", "cli"],
  ),
  description: "Official plugins only: a source of logins for Ardia's own password manager, driving a password manager's CLI through a typed verb catalog. A plugin with it has main only, no other contributions and no permissions",
};
