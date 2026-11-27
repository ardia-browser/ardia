import * as Y from "yjs";
import { hex } from "../../shared/bytes";
import { Sha256 } from "../sha256";

const ID_TRIES = 32;
const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

const shortHash = (text: string) => hex(new Sha256().update(new TextEncoder().encode(text)).digest().subarray(0, 6));

export const exportPageId = (workspace: string, key: string) => shortHash(`notion-export:${workspace}:${key}`);

export const recordsPageId = (workspace: string, key: string) => shortHash(`notion:${workspace}:${key}`);

export const isNotionUuid = (key: string) => UUID.test(key);

export type IdFamily = (attempt: number) => string;

const suffixed = (key: string, attempt: number) => (attempt ? `${key}#${attempt}` : key);

export function notionPageFamilies(workspace: string, key: string): IdFamily[] {
  const uuid = UUID.exec(key);
  if (!uuid) return [(n) => exportPageId(workspace, suffixed(key, n))];
  const compact = uuid.slice(1).join("").toLowerCase();
  const dashed = uuid.slice(1).join("-").toLowerCase();
  return [(n) => exportPageId(workspace, suffixed(compact, n)), (n) => recordsPageId(workspace, suffixed(dashed, n)), (n) => recordsPageId(workspace, suffixed(key, n))];
}

export const recordsOnlyFamily = (workspace: string, key: string): IdFamily[] => [(n) => recordsPageId(workspace, suffixed(key, n))];

export function pickPageId(pages: Y.Map<Y.Map<unknown>>, taken: (id: string) => boolean, families: IdFamily[]): string | null {
  for (let n = 0; n < ID_TRIES; n++)
    for (const family of families) {
      const id = family(n);
      const entry = pages.get(id);
      if (entry && entry.get("deleted") !== true && !taken(id)) return id;
    }
  for (let n = 0; n < ID_TRIES; n++) {
    const id = families[0]!(n);
    const entry = pages.get(id);
    if (!taken(id) && (!entry || entry.get("deleted") !== true)) return id;
  }
  return null;
}

export function knownPageIds(workspace: string, key: string, attempts = 4): string[] {
  const out: string[] = [];
  for (const family of notionPageFamilies(workspace, key)) for (let n = 0; n < attempts; n++) out.push(family(n));
  return out;
}
