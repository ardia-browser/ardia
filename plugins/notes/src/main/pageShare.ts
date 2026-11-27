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

function scan(value: unknown, out: Set<string>, depth = 0) {
  if (depth > 32) return;
  if (typeof value === "string") {
    for (const m of value.matchAll(FILE_REF)) out.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) scan(item, out, depth + 1);
  } else if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) scan(item, out, depth + 1);
  }
}

export function fileRefsOfState(state: Uint8Array, out = new Set<string>()): Set<string> {
  for (const struct of Y.decodeUpdate(state).structs) {
    const content = (struct as { content?: Record<string, unknown> }).content;
    if (!content) continue;
    scan(content.str, out);
    scan(content.arr, out);
    scan(content.value, out);
    scan(content.embed, out);
  }
  return out;
}

export function fileRefsOfEntry(entry: Y.Map<unknown> | undefined, out = new Set<string>()): Set<string> {
  if (entry) scan(entry.toJSON(), out);
  return out;
}
