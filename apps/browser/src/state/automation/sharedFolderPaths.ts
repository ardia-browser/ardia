import { discardSharedFolder, readSharedFolder, resolveSharedFolder, SHARED_FOLDER_REFUSED, type ResolvedSharedFolder } from "../../platform/sharedFolders";
import { errorText } from "../../lib/errors";
import { OpError } from "./workspaceTargets";

export { addKey, bindingAt, oneAtATime } from "../sharedFolders/bindings";

const SYSTEM_ROOTS = ["/", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/bin", "/sbin", "/usr", "/etc", "/var", "/tmp", "/dev", "/opt", "/cores", "/private", "/private/etc", "/private/var", "/private/tmp", "/Network"];

export const isAbsolutePath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");

const homeOf = (path: string) => /^\/Users\/[^/]+$/.test(path);

export async function canonicalFolder(path: string, what: string): Promise<ResolvedSharedFolder> {
  let found: ResolvedSharedFolder;
  try {
    found = await resolveSharedFolder(path);
  } catch (error) {
    const refused = (error as { code?: unknown } | null)?.code === SHARED_FOLDER_REFUSED;
    throw new OpError(refused ? "refused" : "bad_request", `${what}: ${errorText(error)}`);
  }
  const trimmed = found.path.replace(/\/+$/, "") || "/";
  if (SYSTEM_ROOTS.includes(trimmed) || homeOf(trimmed)) throw new OpError("refused", `${what}: ${trimmed} is a system or home folder; pick a folder inside it.`);
  return { ...found, path: trimmed };
}

export async function readableFolder(found: ResolvedSharedFolder) {
  const listing = await readSharedFolder(found.path, { device: found.device, inode: found.inode });
  if (!listing.exists) throw new OpError("bad_request", listing.error ?? `There's no folder at ${found.path}.`);
  if (listing.root.error) throw new OpError("bad_request", listing.root.error);
}

export const discardFolder = (folder: ResolvedSharedFolder) => discardSharedFolder(folder).catch(() => false);
