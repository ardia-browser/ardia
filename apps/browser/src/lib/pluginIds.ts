import { PLUGIN_ID_PATTERN } from "@ardia/plugin-sdk/manifest";

export const PLUGIN_ID = new RegExp(PLUGIN_ID_PATTERN);

export const PLUGIN_KEY_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}(?:__[a-z0-9][a-z0-9-]{0,39})?$";

export const PLUGIN_KEY = new RegExp(PLUGIN_KEY_PATTERN);

export const OFFICIAL_ID_SCOPE = "@ardia";

export const isPluginId = (value: unknown): value is string => typeof value === "string" && PLUGIN_ID.test(value);

export const isPluginKey = (value: unknown): value is string => typeof value === "string" && PLUGIN_KEY.test(value);

export function splitPluginId(id: string): { scope: string; name: string } | null {
  if (!PLUGIN_ID.test(id)) return null;
  const slash = id.indexOf("/");
  return { scope: id.slice(1, slash), name: id.slice(slash + 1) };
}

export function keyOfId(id: string): string | null {
  const parts = splitPluginId(id);
  return parts ? `${parts.scope}__${parts.name}` : null;
}

export function idOfKey(key: string): string | null {
  const split = key.indexOf("__");
  if (split < 0 || !PLUGIN_KEY.test(key)) return null;
  const id = `@${key.slice(0, split)}/${key.slice(split + 2)}`;
  return PLUGIN_ID.test(id) ? id : null;
}

export const isOfficialId = (id: string | null | undefined): boolean => !!id && id.startsWith(`${OFFICIAL_ID_SCOPE}/`) && PLUGIN_ID.test(id);

export function folderMatchesId(folder: string, id: string): boolean {
  const parts = splitPluginId(id);
  return !!parts && (folder === `${parts.scope}__${parts.name}` || folder === parts.name);
}

const INSTALL_LINK = /^ardia:\/\/plugin\/install\/(@[^/?#]+\/[^/?#]+)\/?(?:[?#].*)?$/i;

export function pluginInstallLink(url: string): string | null {
  if (url.length > 200) return null;
  const found = INSTALL_LINK.exec(url.trim());
  if (!found) return null;
  let id: string;
  try {
    id = decodeURIComponent(found[1]!).toLowerCase();
  } catch {
    return null;
  }
  return isPluginId(id) ? id : null;
}
