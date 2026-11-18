import { savePassword } from "../../platform/passwords";
import {
  importModule,
  type BookmarkNode as ImportedNode,
  type Credential,
  type DiaTabsProfile,
  type ImportedFavicon,
  type ImportedTab,
  type ImportKind,
  type ImportResult,
  type SafariExport,
  type SpaceSuggestion,
} from "../../platform/importModule";
import { passwordImportTally } from "../telemetry/passwordSaves";
import { bookmarkRoots, type BookmarkDraft } from "../bookmarks/bookmarks";
import { useBrowser } from "../browser/store";
import { isIncognitoSpace } from "../browser/model";
import { openPages, pageKey } from "../tabs/pageKeys";
import type { ProfileColor } from "../browser/types";
import { DEFAULT_SPACE } from "../spaces/spaces";
import { focusedWindowOf } from "../windows/ui";
import { originOfLogin } from "../site/savedPasswords";
import { importFavicons, importTabs, linksOf, windowFor } from "./tabImport";

export { importTabs };
export { importArcSpace, importDiaSpace } from "./sidebarTree";

export type { BrowserProfile, BrowserSource, DiaTabsResult, ImportedExtension, ImportKind, ImportResult, SpaceSuggestion, SpaceSummary } from "../../platform/importModule";

export type ImportCounts = { bookmarks: number; history: number; tabs: number; passwords: number; cookies: number; addresses: number; cards: number; rules: number; archived: number; settings: number };

export const emptyCounts = (): ImportCounts => ({ bookmarks: 0, history: 0, tabs: 0, passwords: 0, cookies: 0, addresses: 0, cards: 0, rules: 0, archived: 0, settings: 0 });

export const IMPORT_DESTINATION_CHANGED = "The destination Space or Profile changed during import. Choose a destination and import again.";
export type ImportDestination = { spaceId: string; profileId: string; engineId: string; current: () => boolean };

export function importDestination(spaceId: string): ImportDestination | null {
  const s = useBrowser.getState();
  const profile = s.profiles[s.spaces[spaceId]?.profileId ?? ""];
  if (!profile || isIncognitoSpace(spaceId)) return null;
  const { id: profileId, engineId } = profile;
  return { spaceId, profileId, engineId, current: () => {
    const now = useBrowser.getState();
    return now.spaces[spaceId]?.profileId === profileId && now.profiles[profileId]?.engineId === engineId;
  } };
}

const toDraft = (n: ImportedNode): BookmarkDraft =>
  n.type === "url"
    ? { title: n.title || n.url || "", url: n.url ?? "", addedAt: n.dateAdded }
    : { title: n.title, addedAt: n.dateAdded, children: (n.children ?? []).map(toDraft) };

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

export function importBookmarks(spaceId: string, root: ImportedNode | undefined, browserName: string): number {
  if (!root?.children?.length) return 0;
  if (!bookmarkRoots(useBrowser.getState(), spaceId)) useBrowser.getState().addBookmarkTree(spaceId, []);
  const roots = bookmarkRoots(useBrowser.getState(), spaceId)!;
  const toolbar = root.children.filter((c) => c.role === "toolbar").flatMap((c) => c.children ?? []);
  const rest = root.children.filter((c) => c.role !== "toolbar");
  const other = rest.flatMap((c) => (c.role === "other" || !c.role ? (c.type === "folder" ? (c.children ?? []) : [c]) : [c]));
  const title = `Imported from ${browserName}`;
  const place = (nodes: ImportedNode[], parentId: string) => {
    if (!nodes.length) return;
    const parent = useBrowser.getState().bookmarks.nodes[parentId];
    const empty = parent?.kind === "folder" && parent.children.length === 0;
    const drafts = nodes.map(toDraft);
    useBrowser.getState().addBookmarkTree(spaceId, empty ? drafts : [{ title, children: drafts }], parentId);
  };
  place(toolbar, roots.bar);
  place(other, roots.other);
  return linkCount([...toolbar, ...other]);
}

export function importHistory(spaceId: string, entries: { url: string; title: string; visits: number; lastVisit: number }[]): number {
  return useBrowser.getState().importHistory(spaceId, entries);
}

async function importPasswords(destination: ImportDestination, credentials: Credential[], onFailed?: (kind: ImportKind) => void): Promise<number> {
  const tally = passwordImportTally("browser");
  let saved = 0;
  for (const credential of credentials) {
    if (!destination.current()) {
      onFailed?.("passwords");
      break;
    }
    const origin = originOfLogin(credential.realm?.startsWith("http") ? credential.realm : credential.url);
    if (!origin || !credential.password) continue;
    if (await tally.attempt(savePassword(destination.engineId, origin, credential.username, credential.password))) saved++;
  }
  tally.done();
  return saved;
}

export async function importNative(
  spaceId: string,
  token: string | undefined,
  kinds: ("cookies" | "autofill")[],
  onFailed?: (kind: ImportKind) => void,
  destination: ImportDestination | null = importDestination(spaceId),
): Promise<Pick<ImportCounts, "cookies" | "addresses" | "cards">> {
  const none = { cookies: 0, addresses: 0, cards: 0 };
  if (!token) return none;
  const api = importModule();
  if (!api || !token) return none;
  if (!kinds.length || !destination?.current()) {
    api.discardImported(token);
    if (!destination?.current()) kinds.forEach((k) => onFailed?.(k));
    return none;
  }
  try {
    const w = await api.writeImported(token, destination.engineId, kinds);
    if (w.cookiesFailed) onFailed?.("cookies");
    if (w.autofillFailed) onFailed?.("autofill");
    return { cookies: w.cookies, addresses: w.addresses, cards: w.cards };
  } catch {
    kinds.forEach((k) => onFailed?.(k));
    return none;
  }
}

export function openInWebStore(spaceId: string, urls: string[]) {
  if (!urls.length) return;
  const windowId = windowFor(spaceId);
  urls.forEach((url, i) => useBrowser.getState().newTab(windowId, { url, spaceId, background: i > 0 }));
}

export function importFavorites(profileId: string, tabs: ImportedTab[], favicons?: ImportedFavicon[]): number {
  if (!tabs.length) return 0;
  importFavicons(profileId, favicons, tabs.map((t) => t.url));
  return importTabs(profileId, tabs.map((t) => ({ ...t, pinned: true })), null, "tiles");
}

export function importDiaProfile(spaceId: string, profile: DiaTabsProfile, what: { pinned: boolean; open: boolean }, favicons?: ImportedFavicon[]): number {
  importFavicons(spaceId, favicons, [...(what.pinned ? profile.pinned : []), ...(what.open ? profile.tabs : [])].map((t) => t.url));
  const have = openPages(useBrowser.getState(), spaceId);
  const fresh = (tabs: ImportedTab[]) => tabs.filter((t) => !have.has(pageKey(t.url)));
  let n = what.pinned ? importTabs(spaceId, fresh(profile.pinned), null) : 0;
  if (what.open) n += importTabs(spaceId, fresh(profile.tabs).map((t) => ({ ...t, pinned: false })), "Imported");
  return n;
}

export async function applyResult(
  spaceId: string,
  result: ImportResult,
  browserName: string,
  requested: ImportKind[],
  onFailed?: (kind: ImportKind) => void,
  destination: ImportDestination | null = importDestination(spaceId),
): Promise<ImportCounts> {
  const counts = emptyCounts();
  if (!destination?.current()) {
    if (result.vaultToken) importModule().discardImported(result.vaultToken);
    requested.forEach((k) => onFailed?.(k));
    return counts;
  }
  const toolbar = (result.bookmarks?.children ?? []).filter((c) => c.role === "toolbar");
  importFavicons(spaceId, result.favicons, [...result.favorites.map((t) => t.url), ...(result.spaces.length ? [] : result.tabs.map((t) => t.url)), ...linksOf(toolbar)]);
  const native = (["cookies", "autofill"] as const).filter((k) => requested.includes(k));
  Object.assign(counts, await importNative(spaceId, result.vaultToken, native, onFailed, destination));
  if (!destination.current()) { requested.forEach((k) => onFailed?.(k)); return counts; }
  counts.bookmarks += importBookmarks(spaceId, result.bookmarks, browserName);
  if (result.history.length) counts.history += importHistory(spaceId, result.history);
  if (result.tabs.length && !result.spaces.length) counts.tabs += importTabs(spaceId, result.tabs, "Imported");
  if (result.favorites.length) counts.tabs += importTabs(spaceId, result.favorites.map((t) => ({ ...t, pinned: true })), null, "tiles");
  if (result.credentials.length) counts.passwords += await importPasswords(destination, result.credentials, onFailed);
  return counts;
}

export async function applySafari(spaceId: string, data: SafariExport, cookies = true, onFailed?: (kind: ImportKind) => void, destination: ImportDestination | null = importDestination(spaceId)): Promise<ImportCounts> {
  const counts = emptyCounts();
  const requested: ImportKind[] = ["bookmarks", "history", "tabs", "passwords", "autofill", ...(cookies ? ["cookies" as const] : [])];
  if (!destination?.current()) {
    if (data.vaultToken) importModule().discardImported(data.vaultToken);
    requested.forEach((k) => onFailed?.(k));
    return counts;
  }
  Object.assign(counts, await importNative(spaceId, data.vaultToken, cookies ? ["cookies", "autofill"] : ["autofill"], onFailed, destination));
  if (!destination.current()) { requested.forEach((k) => onFailed?.(k)); return counts; }
  counts.bookmarks = importBookmarks(spaceId, data.bookmarks, "Safari");
  const history = data.profiles.find((p) => !p.name)?.history ?? data.profiles[0]?.history ?? [];
  counts.history = importHistory(spaceId, history);
  if (data.tabs.length) counts.tabs += importTabs(spaceId, data.tabs, "Imported");
  counts.passwords = await importPasswords(destination, data.credentials, onFailed);
  return counts;
}

export function spaceColorFor(hex: string | undefined): ProfileColor | undefined {
  const m = hex && /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return "neutral";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  const hues: [ProfileColor, number][] = [
    ["red", 0],
    ["orange", 25],
    ["yellow", 45],
    ["green", 140],
    ["blue", 210],
    ["purple", 265],
    ["pink", 330],
    ["red", 360],
  ];
  return hues.reduce((best, c) => (Math.abs(c[1] - h) < Math.abs(best[1] - h) ? c : best))[0];
}

export function defaultTarget(): string {
  const s = useBrowser.getState();
  const w = s.windows[focusedWindowOf(s) ?? ""];
  return w && w.kind !== "private" ? w.spaceId : s.settings.defaultSpaceId;
}

export function adoptSpaceIdentity(spaceId: string, space: Pick<SpaceSuggestion, "name" | "color" | "emoji">): boolean {
  const s = useBrowser.getState();
  const current = s.spaces[spaceId];
  const name = space.name.trim();
  const untouched = spaceId === DEFAULT_SPACE.id && current?.name === DEFAULT_SPACE.name &&
    current.color === DEFAULT_SPACE.color && current.icon == null && !current.theme;
  if (!current || !untouched || !name || s.spaceOrder.length !== 1) return false;
  const color = spaceColorFor(space.color);
  s.updateSpace(spaceId, { name, icon: space.emoji ?? null, ...(color ? { color } : {}) });
  return true;
}

export function spaceNamed(name: string): string | undefined {
  const s = useBrowser.getState();
  return s.spaceOrder.find((id) => s.spaces[id]!.name.trim().toLowerCase() === name.trim().toLowerCase());
}
