import type { SyncKeys } from "./crypto.ts";

const PREFIX = "pw:";
const MARKER = `"${PREFIX}`;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function password(value: Json, keys: SyncKeys, hiding: boolean): Json {
  if (!isObject(value) || typeof value.o !== "string" || typeof value.u !== "string") return value;
  const login: JsonObject = { ...value };
  if (hiding && typeof login.p === "string") {
    login.s = keys.sealPassword(login.p, value.o, value.u);
    delete login.p;
  } else if (!hiding && typeof login.s === "string") {
    login.p = keys.openPassword(login.s, value.o, value.u);
    delete login.s;
  }
  return login;
}

function walk(node: Json, keys: SyncKeys, hiding: boolean): Json {
  if (Array.isArray(node)) return node.map((item) => walk(item, keys, hiding));
  if (!isObject(node)) return node;
  if (typeof node.k === "string" && node.k.startsWith(PREFIX) && node.v !== undefined) return { ...node, v: password(node.v, keys, hiding) };
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith(PREFIX)) out[key] = walk(value, keys, hiding);
    else if (typeof value === "string") continue;
    else if (isObject(value) && value.v !== undefined) out[key] = { ...value, v: password(value.v, keys, hiding) };
    else out[key] = value;
  }
  return out;
}

const rewrite = (json: string, keys: SyncKeys, hiding: boolean) => JSON.stringify(walk(JSON.parse(json) as Json, keys, hiding));

export function hidePasswords(json: string, keys: SyncKeys): string | null {
  if (!json.includes(MARKER)) return json;
  try {
    return rewrite(json, keys, true);
  } catch {
    return null;
  }
}

export function restorePasswords(json: string, keys: SyncKeys): string {
  if (!json.includes(MARKER)) return json;
  return rewrite(json, keys, false);
}
