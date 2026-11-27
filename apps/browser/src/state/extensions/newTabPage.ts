import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { newTabOpensOf } from "../settings/settings";
import type { InstalledExtension } from "../../platform/extensions";

type NewTabCandidate = Pick<InstalledExtension, "id" | "enabled" | "newTabPage">;

let listsByProfile: Readonly<Record<string, readonly NewTabCandidate[]>> = {};

export const noteExtensionLists = (lists: Readonly<Record<string, readonly NewTabCandidate[]>>) => void (listsByProfile = lists);

const EXTENSION_ID = /^[a-p]{32}$/;
const MAX_PAGE_PATH = 1024;
const UNSAFE_PATH_CHARACTER = /[\\\s\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ud800-\udfff]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function extensionNewTabPage(ext: NewTabCandidate): string | undefined {
  const path = ext.newTabPage;
  if (ext.enabled !== true || typeof ext.id !== "string" || !EXTENSION_ID.test(ext.id) || typeof path !== "string") return undefined;
  const relative = path.replace(/^\/+/, "");
  if (!relative || relative.length > MAX_PAGE_PATH || UNSAFE_PATH_CHARACTER.test(relative) || SCHEME.test(relative)) return undefined;
  const file = relative.split(/[?#]/, 1)[0]!;
  if (!file || file.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  return `chrome-extension://${ext.id}/${relative}`;
}

export function extensionNewTabUrl(s: Pick<BrowserState, "settings" | "windows" | "profiles">, windowId: string, profileId?: string | null): string | undefined {
  if (newTabOpensOf(s.settings) !== "page") return undefined;
  const w = s.windows[windowId];
  const own = profileId ?? w?.profileId;
  if (!own || w?.kind === "private" || isIncognitoProfile(own)) return undefined;
  for (const ext of listsByProfile[engineProfile(s, own)] ?? []) {
    const url = extensionNewTabPage(ext);
    if (url) return url;
  }
  return undefined;
}
