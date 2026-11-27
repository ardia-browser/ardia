import { isFields } from "../../lib/decode";
import type { PluginFolderGrant, PluginFolderGrants } from "./store";

export const MAX_FOLDER_GRANTS = 32;
export const FOLDER_NAME_MAX = 100;
const GRANT_ID = /^f[0-9a-f]{10}$/;
const PATH_MAX = 4096;

export const isGrantId = (value: unknown): value is string => typeof value === "string" && GRANT_ID.test(value);

const UNSAFE_NAME = /[/:\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

export function folderNameProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "name is the folder's name, 1 to 100 characters.";
  if ([...value].length > FOLDER_NAME_MAX) return `name is at most ${FOLDER_NAME_MAX} characters.`;
  if (value.startsWith(".")) return "name can't start with a dot.";
  if (UNSAFE_NAME.test(value)) return "name can't hold /, : or control characters.";
  return null;
}

const isIdentityPart = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const grantIdentity = (grant: PluginFolderGrant): { device: number; inode: number } | null => (grant.device !== undefined && grant.inode !== undefined ? { device: grant.device, inode: grant.inode } : null);

function grantOf(raw: unknown): PluginFolderGrant | null {
  if (!isFields(raw)) return null;
  const { name, path, location, addedAt } = raw;
  if (typeof name !== "string" || !name || name.length > 255 || typeof path !== "string" || !path.startsWith("/") || path.length > PATH_MAX || path.includes("\u0000")) return null;
  const identity = isIdentityPart(raw.device) && isIdentityPart(raw.inode) ? { device: raw.device, inode: raw.inode } : {};
  return { name, path, location: location === "icloud" ? "icloud" : "other", addedAt: typeof addedAt === "number" && Number.isSafeInteger(addedAt) && addedAt >= 0 ? addedAt : 0, ...identity };
}

export function folderGrantsOf(raw: unknown): PluginFolderGrants | null {
  if (!isFields(raw)) return null;
  const entries = Object.entries(raw).flatMap(([id, value]): [string, PluginFolderGrant][] => {
    const grant = isGrantId(id) ? grantOf(value) : null;
    return grant ? [[id, grant]] : [];
  });
  return entries.length ? Object.fromEntries(entries.slice(0, MAX_FOLDER_GRANTS)) : null;
}
