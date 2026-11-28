import { LIMITS_V3, STATE_EVENTS_V3, STATE_INTENTS_V3, matchPattern, networkHost } from "./manifestParts";
import { arr, bool, obj, oneOf, union, type Infer } from "./spec";

const off = oneOf([false] as const);

export const activePageSpec = union(
  [
    oneOf([false, true] as const),
    obj(
      {
        read: bool("Read the page's text, markdown and metadata"),
        screenshot: bool("Take a screenshot of the visible page"),
        multiTab: bool("Read tabs other than the active one, by id"),
      },
      { what: "permissions.activePage" },
    ),
  ],
  "true, false or an object with read, screenshot and multiTab",
  "Read the page you're on, for 30 seconds after you use the plugin",
);

export const stateSpec = union(
  [
    off,
    obj(
      {
        events: arr(oneOf(STATE_EVENTS_V3), { max: STATE_EVENTS_V3.length, unique: true, description: "State changes the plugin hears after Ardia commits them, redacted" }),
        intents: arr(oneOf(STATE_INTENTS_V3), { max: STATE_INTENTS_V3.length, unique: true, description: "Changes the plugin may ask Ardia to make" }),
      },
      { what: "permissions.state" },
    ),
  ],
  "false or an object with events and intents",
  "Redacted state events it hears and intents it may ask for",
);

export const permissionsSpec = obj(
  {
    tabs: oneOf([false, "read", "write"] as const, "read: see your tabs. write: also open, move and close them"),
    fullUrls: bool("See whole addresses, with what follows ? and # (needs tabs)"),
    activePage: activePageSpec,
    pages: union([off, arr(matchPattern, { min: 1, max: LIMITS_V3.pages, unique: true })], `false or a list of 1 to ${LIMITS_V3.pages} URL match patterns`, "Pages its pageStyles and contentScripts may run on"),
    workspace: bool("See and rearrange every window, tab and group (needs tabs: write and fullUrls)"),
    bookmarks: oneOf([false, "read", "write"] as const),
    history: oneOf([false, "read"] as const),
    downloads: oneOf([false, "read"] as const),
    media: oneOf([false, "read", "control"] as const),
    profiles: oneOf([false, "read", "write"] as const),
    clipboard: oneOf([false, "write", "read"] as const, "write: copy to the clipboard. read: also read it, when you use the plugin"),
    notifications: bool("Show system notifications"),
    files: oneOf([false, "picker"] as const, "picker: open and save files you pick"),
    commands: bool("Run Ardia commands"),
    storage: bool("Keep its own data"),
    secrets: bool("Keep secrets in the Keychain"),
    control: bool("Let programs you run fully control Ardia, including your signed-in sites"),
    network: union(
      [oneOf([false, "*"] as const), arr(networkHost, { min: 1, max: LIMITS_V3.networkHosts, unique: true })],
      `false, "*" or a list of 1 to ${LIMITS_V3.networkHosts} hosts`,
      'false, "*" or hosts like api.example.com, *.example.com and localhost:8080',
    ),
    state: stateSpec,
  },
  { what: "permissions" },
);

export type PermissionsV3 = Infer<typeof permissionsSpec>;

export const PERMISSION_KEYS = [
  "tabs",
  "fullUrls",
  "activePage",
  "pages",
  "workspace",
  "bookmarks",
  "history",
  "downloads",
  "media",
  "profiles",
  "clipboard",
  "notifications",
  "files",
  "commands",
  "storage",
  "secrets",
  "control",
  "network",
  "state",
] as const satisfies readonly (keyof PermissionsV3)[];

const LEVELS: Record<string, readonly unknown[]> = {
  tabs: [false, "read", "write"],
  bookmarks: [false, "read", "write"],
  history: [false, "read"],
  downloads: [false, "read"],
  media: [false, "read", "control"],
  profiles: [false, "read", "write"],
  clipboard: [false, "write", "read"],
  files: [false, "picker"],
};

function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableText(record[key])}`)
      .join(",")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function permissionGrants(permissions: PermissionsV3 | Readonly<Record<string, unknown>> | undefined): string[] {
  const grants: string[] = [];
  const p = (permissions ?? {}) as Record<string, unknown>;
  for (const [key, levels] of Object.entries(LEVELS)) {
    const value = p[key] ?? false;
    const index = levels.indexOf(value);
    if (index < 0) grants.push(`${key}:${String(value)}`);
    for (let i = 1; i <= index; i++) grants.push(`${key}:${String(levels[i])}`);
  }
  for (const key of ["fullUrls", "workspace", "notifications", "commands", "storage", "secrets", "control"]) {
    const value = p[key];
    if (value === true) grants.push(key);
    else if (value !== undefined && value !== false) grants.push(`${key}:${String(value)}`);
  }
  const active = p.activePage;
  if (active === true) grants.push("activePage:read");
  else if (active && typeof active === "object") {
    for (const [part, on] of Object.entries(active as Record<string, unknown>)) if (on) grants.push(`activePage:${part}`);
  } else if (active !== undefined && active !== false) grants.push(`activePage:${String(active)}`);
  if (Array.isArray(p.pages)) for (const match of p.pages) grants.push(`pages:${String(match)}`);
  else if (p.pages !== undefined && p.pages !== false) grants.push(`pages:${String(p.pages)}`);
  if (p.network === "*") grants.push("network:*");
  else if (Array.isArray(p.network)) for (const host of p.network) grants.push(`network:${String(host)}`);
  else if (p.network !== undefined && p.network !== false) grants.push(`network:${String(p.network)}`);
  const state = p.state;
  if (state && typeof state === "object") {
    const { events, intents } = state as { events?: unknown; intents?: unknown };
    for (const event of Array.isArray(events) ? events : []) grants.push(`state.events:${String(event)}`);
    for (const intent of Array.isArray(intents) ? intents : []) grants.push(`state.intents:${String(intent)}`);
  } else if (state !== undefined && state !== false) grants.push(`state:${String(state)}`);
  for (const [key, value] of Object.entries(p)) {
    if ((PERMISSION_KEYS as readonly string[]).includes(key) || value === undefined || value === null || value === false) continue;
    grants.push(`unknown:${key}=${stableText(value)}`);
  }
  return [...new Set(grants)].sort();
}
