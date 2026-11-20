import type { JsonSchema } from "../../lib/jsonSchema";
import { errorText } from "../../lib/errors";
import { failure, type MethodError } from "./automationMethods";
import { obj, ownField, schemaProblem } from "./socketSchema";
import { OpError } from "./workspaceTargets";

export const STOPPED = "Control was turned off before Ardia made the change, so nothing changed.";

export type SocketBody = { result: unknown } | { error: MethodError };

export type SocketCall = { connection: number; serving: () => boolean; stillServing: () => void };

export type MethodSpec = {
  name: string;
  mutates: boolean;
  description: string;
  params: JsonSchema;
  result: string;
  run?: (params: Record<string, unknown>, call: SocketCall) => unknown;
  hidden?: boolean;
};

export type MethodEntry = { name: string; area: string; mutates: boolean; description: string; params: JsonSchema; result: string };

export type ConnectionAccess = "owner" | "plugin";

export const PLUGIN_SESSION_METHODS: ReadonlySet<string> = new Set(["hello", "methods"]);

export const SOCKET_FAMILIES = ["core", "workspace", "tabs", "windows", "profiles", "splits", "peek", "bookmarks", "history", "downloads", "settings", "sites", "extensions", "plugins", "media", "sync", "secrets", "pins", "favicons", "shared_folders", "live", "presets", "air_traffic", "permissions", "menus"] as const;
export type SocketFamily = (typeof SOCKET_FAMILIES)[number];

const FAMILY_OF_AREA: Record<string, SocketFamily> = {
  apply: "workspace",
  workspace: "workspace",
  offscreen: "workspace",
  run: "workspace",
  tabs: "tabs",
  closed: "tabs",
  windows: "windows",
  littleArdia: "windows",
  profiles: "profiles",
  splits: "splits",
  peek: "peek",
  bookmarks: "bookmarks",
  history: "history",
  downloads: "downloads",
  settings: "settings",
  search: "settings",
  sites: "sites",
  extensions: "extensions",
  plugins: "plugins",
  media: "media",
  sync: "sync",
  passwords: "secrets",
  autofill: "secrets",
  pins: "pins",
  favicons: "favicons",
  sharedFolders: "shared_folders",
  live: "live",
  presets: "presets",
  airTraffic: "air_traffic",
  permissions: "permissions",
  menus: "menus",
};

export const areaOf = (name: string) => name.split(".")[0]!;
export const familyOf = (name: string): SocketFamily => ownField(FAMILY_OF_AREA, areaOf(name)) ?? "core";

const core = (name: string, mutates: boolean, description: string, result: string, params: JsonSchema = obj({})): MethodSpec => ({ name, mutates, description, params, result });

const NULLABLE_ID = { type: ["string", "null"] } as const satisfies JsonSchema;
const SECONDS: JsonSchema = { type: "array", items: { type: "integer" }, description: "Idle thresholds in whole seconds" };
const PLUGIN_NAME = obj({ name: { type: "string", description: "A plugin name from plugins" } }, ["name"]);

export const CORE_METHODS: MethodSpec[] = [
  core("hello", false, "Protocol handshake; send it first with your protocol", "{app, version, protocol, minClientProtocol}", {
    type: "object",
    properties: { protocol: { type: "integer" }, caller: { type: "object", description: "{name, app} of the program calling" } },
  }),
  core("caller", false, "Note the caller named in hello as the one running now", "{ok}"),
  core("methods", false, "Every method the socket answers, with its params schema, result and whether it changes anything", "[{name, area, mutates, description, params, result}]"),
  core("commands", false, "The menu commands run takes", "[{id, title, …}]"),
  core("windows", false, "Windows and their tabs, with each tab's DevTools target", "[{id, kind, focused, profile, profileName, tabs}]"),
  core("workspace", false, "The sidebar tree of a window or profile: pinned, groups and tabs", "{windows, …}", obj({ window: NULLABLE_ID, profile: NULLABLE_ID, usage: { type: "boolean" } })),
  core("apply", true, "A batch of ops on tabs, groups and pins: open, tab.*, group.*", "{ok, applied, results, tabs, groups, windows}", obj({ ops: { type: "array" } }, ["ops"])),
  core("run", true, "Run a menu command in a window or on a tab", "{ok}", obj({ command: { type: "string" }, arg: { type: ["string", "null"] }, window: NULLABLE_ID, tab: NULLABLE_ID }, ["command"])),
  core("offscreen", true, "Move a tab the command opened off-screen", "{ok}", obj({ tab: { type: "string" } }, ["tab"])),
  core(
    "subscribe",
    true,
    "Receive events on this connection, and serve decide hooks from it; replaces this connection's earlier subscription",
    "{ok, served, revisions?}",
    obj(
      {
        events: { type: "array", items: { type: "string" }, description: "Event names, or [\"*\"]" },
        fullUrls: { type: "boolean", description: "Full URLs in events instead of origin and path" },
        idle: obj({ tab: SECONDS, user: SECONDS }),
        hooks: { type: ["array", "null"], description: "Decide and omnibox hooks from hooks.json this connection answers; null stops serving" },
      },
      ["events"],
    ),
  ),
  core("answer", true, "Answer a decide hook; Ardia acts on the answer", "{ok}", obj({ decide: { type: "string", description: "The decide request's id" }, answer: { description: "An object, a list or null; anything else makes Ardia use its default" } }, ["decide"])),
  core("plugins", false, "Installed plugins", "[{name, title, version, enabled, active, tools, …}]"),
  core("plugins.official", false, "The official plugins Ardia offers", "[…]"),
  core("plugins.enable", true, "Ask the user to turn a plugin on (shows its consent sheet)", "{ok} | {waiting}", PLUGIN_NAME),
  core("plugins.disable", true, "Turn a plugin off", "{ok}", PLUGIN_NAME),
  core("plugins.remove", true, "Remove a plugin", "{ok}", PLUGIN_NAME),
  core("plugins.call", true, "Call a plugin's tool", "the tool's result", obj({ plugin: { type: "string" }, tool: { type: "string" }, input: {} }, ["plugin", "tool"])),
];

let added: MethodSpec[] = [];
const byName = new Map<string, MethodSpec>(CORE_METHODS.map((spec) => [spec.name, spec]));

export function registerSocketMethods(specs: readonly MethodSpec[]) {
  for (const spec of specs) {
    if (byName.has(spec.name)) throw new Error(`Socket method ${spec.name} is defined twice.`);
    byName.set(spec.name, spec);
  }
  added = [...added, ...specs];
}

export const methodsCatalog = (): MethodEntry[] =>
  [...CORE_METHODS, ...added].filter((m) => !m.hidden).map(({ name, mutates, description, params, result }) => ({ name, area: areaOf(name), mutates, description, params, result }));

export const methodSpec = (name: string): MethodSpec | undefined => byName.get(name);

export function accessProblem(access: ConnectionAccess, spec: MethodSpec): MethodError | null {
  if (access === "owner" || PLUGIN_SESSION_METHODS.has(spec.name)) return null;
  return failure("refused", `A plugin's session can't call ${spec.name}.`).error;
}

const PROTOTYPE_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), "toJSON", "then"]);

export class UnlistedParamError extends Error {}

const isClosedObject = (schema: JsonSchema | undefined): schema is JsonSchema => !!schema && schema.additionalProperties === false && typeof schema.properties === "object";

function guarded(method: string, schema: JsonSchema, value: Record<string, unknown>, path: string): Record<string, unknown> {
  const listed = schema.properties ?? {};
  const check = (key: string | symbol) => {
    if (typeof key === "string" && !Object.hasOwn(listed, key) && !PROTOTYPE_KEYS.has(key)) throw new UnlistedParamError(`${method} read ${path}${String(key)}, which its params schema doesn't list.`);
  };
  const wrapped = (key: string | symbol, found: unknown) => {
    const nested = typeof key === "string" ? ownField(listed, key) : undefined;
    if (isClosedObject(nested) && typeof found === "object" && found !== null && !Array.isArray(found)) return guarded(method, nested, found as Record<string, unknown>, `${path}${String(key)}.`);
    return found;
  };
  return new Proxy(value, {
    get(target, key, receiver) {
      check(key);
      return wrapped(key, Reflect.get(target, key, receiver));
    },
    has(target, key) {
      check(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      check(key);
      const found = Reflect.getOwnPropertyDescriptor(target, key);
      return found && "value" in found && found.configurable ? { ...found, value: wrapped(key, found.value) } : found;
    },
  });
}

export const listedParams = (spec: MethodSpec, params: Record<string, unknown>): Record<string, unknown> => guarded(spec.name, spec.params, params, "");

export function checkedParams(spec: MethodSpec, params: Record<string, unknown>): { params: Record<string, unknown> } | SocketBody {
  const problem = schemaProblem(spec.params, params, "params");
  if (problem) return failure("bad_request", `${spec.name}: ${problem}`);
  return { params: listedParams(spec, params) };
}

const asBody = (thrown: unknown): SocketBody => (thrown instanceof OpError ? failure(thrown.code, thrown.message) : failure("failed", errorText(thrown)));

export function runSpec(spec: MethodSpec, params: Record<string, unknown>, call: SocketCall): SocketBody | Promise<SocketBody> | null {
  if (!spec.run) return null;
  try {
    const out = spec.run(params, call);
    if (out instanceof Promise) return out.then((result) => ({ result }), asBody);
    return { result: out };
  } catch (thrown) {
    return asBody(thrown);
  }
}

export function servingWhile(stillOn: () => boolean, connection = 0): SocketCall {
  return {
    connection,
    serving: stillOn,
    stillServing: () => {
      if (!stillOn()) throw new OpError("failed", STOPPED);
    },
  };
}
