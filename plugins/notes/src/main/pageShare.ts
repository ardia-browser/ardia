import * as Y from "yjs";

const WS_ID = /^[0-9a-f]{12,32}$/;
const PAGE_ID = /^[0-9a-f]{12}$/;
const FILE_REF = /file:([0-9a-f]{64})/g;
export const WORKSPACE_JSON_MAX = 4096;

export type WorkspaceJson = { id: string; name: string; root: string | null };

export function parseWorkspaceJson(text: string | null): WorkspaceJson | null {
  if (!text || text.length > WORKSPACE_JSON_MAX) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.format !== "ardia-notes" || typeof v.id !== "string" || !WS_ID.test(v.id)) return null;
  const name = typeof v.name === "string" ? v.name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 120) : "";
  const root = typeof v.root === "string" && PAGE_ID.test(v.root) ? v.root : null;
  return { id: v.id, name, root };
}

const FILE_URL = /^file:([0-9a-f]{64})(?:\.[a-z0-9]{1,10})?$/;
const URL_KEYS = new Set(["url", "icon", "cover", "src"]);

export type Attachments = Map<string, string>;

function note(out: Attachments, value: unknown, name: unknown) {
  if (typeof value !== "string") return;
  const sha = FILE_URL.exec(value)?.[1];
  if (!sha) return;
  if (!out.has(sha) || (typeof name === "string" && name && !out.get(sha))) out.set(sha, typeof name === "string" ? name.slice(0, 120) : "");
}

function scanValue(value: unknown, out: Attachments, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scanValue(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of URL_KEYS) note(out, record[key], record.name);
  for (const item of Object.values(record)) if (item && typeof item === "object") scanValue(item, out, depth + 1);
}

export function attachmentsOfState(state: Uint8Array, out: Attachments = new Map()): Attachments {
  const byParent = new Map<string, { urls: unknown[]; name: unknown }>();
  for (const struct of Y.decodeUpdate(state).structs) {
    const item = struct as { parent?: unknown; parentSub?: string | null; content?: { arr?: unknown[] }; id?: { client: number; clock: number } };
    const key = item.parentSub;
    const value = item.content?.arr?.[0];
    if (!key || value === undefined) continue;
    const parent = typeof item.parent === "string" ? item.parent : item.parent && typeof item.parent === "object" ? `${(item.parent as { client: number }).client}:${(item.parent as { clock: number }).clock}` : "";
    const slot = byParent.get(parent) ?? { urls: [], name: undefined };
    if (URL_KEYS.has(key)) slot.urls.push(value);
    else if (key === "name") slot.name = value;
    else if (value && typeof value === "object") scanValue(value, out);
    byParent.set(parent, slot);
  }
  for (const slot of byParent.values()) for (const url of slot.urls) note(out, url, slot.name);
  return out;
}

export function attachmentsOfEntry(entry: Y.Map<unknown> | undefined, out: Attachments = new Map()): Attachments {
  if (!entry) return out;
  note(out, entry.get("cover"), "cover");
  note(out, entry.get("icon"), "icon");
  const props = entry.get("props");
  if (props instanceof Y.Map) scanValue(props.toJSON(), out);
  return out;
}
