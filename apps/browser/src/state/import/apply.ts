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
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { openPages, pageKey } from "../tabs/pageKeys";
import type { ProfileColor } from "../browser/types";
import { DEFAULT_PROFILE } from "../profiles/profiles";
import { focusedWindowOf } from "../windows/ui";
import { originOfLogin } from "../site/savedPasswords";
import { importFavicons, importTabs, linksOf, windowFor } from "./tabImport";

export { importTabs };
export { importArcSpace, importDiaSpace } from "./sidebarTree";

export type { BrowserProfile, BrowserSource, DiaTabsResult, ImportedExtension, ImportKind, ImportResult, SpaceSuggestion, SpaceSummary } from "../../platform/importModule";

export type ImportCounts = { bookmarks: number; history: number; tabs: number; passwords: number; cookies: number; addresses: number; cards: number };

export const emptyCounts = (): ImportCounts => ({ bookmarks: 0, history: 0, tabs: 0, passwords: 0, cookies: 0, addresses: 0, cards: 0 });

const toDraft = (n: ImportedNode): BookmarkDraft =>
  n.type === "url"
    ? { title: n.title || n.url || "", url: n.url ?? "", addedAt: n.dateAdded }
    : { title: n.title, addedAt: n.dateAdded, children: (n.children ?? []).map(toDraft) };

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

export function importBookmarks(profileId: string, root: ImportedNode | undefined, browserName: string): number {
  if (!root?.children?.length) return 0;
  if (!bookmarkRoots(useBrowser.getState(), profileId)) useBrowser.getState().addBookmarkTree(profileId, []);
  const roots = bookmarkRoots(useBrowser.getState(), profileId)!;
  const toolbar = root.children.filter((c) => c.role === "toolbar").flatMap((c) => c.children ?? []);
  const rest = root.children.filter((c) => c.role !== "toolbar");
  const other = rest.flatMap((c) => (c.role === "other" || !c.role ? (c.type === "folder" ? (c.children ?? []) : [c]) : [c]));
  const title = `Imported from ${browserName}`;
  const place = (nodes: ImportedNode[], parentId: string) => {
    if (!nodes.length) return;
    const parent = useBrowser.getState().bookmarks.nodes[parentId];
    const empty = parent?.kind === "folder" && parent.children.length === 0;
    const drafts = nodes.map(toDraft);
    useBrowser.getState().addBookmarkTree(profileId, empty ? drafts : [{ title, children: drafts }], parentId);
  };
  place(toolbar, roots.bar);
  place(other, roots.other);
  return linkCount([...toolbar, ...other]);
}

export function importHistory(profileId: string, entries: { url: string; title: string; visits: number; lastVisit: number }[]): number {
  return useBrowser.getState().importHistory(profileId, entries);
}

async function importPasswords(profileId: string, credentials: Credential[]): Promise<number> {
  const tally = passwordImportTally("browser");
  let saved = 0;
  for (const c of credentials) {
    const origin = originOfLogin(c.realm?.startsWith("http") ? c.realm : c.url);
    if (!origin || !c.password) continue;
    if (await tally.attempt(savePassword(engineProfile(useBrowser.getState(), profileId), origin, c.username, c.password))) saved++;
  }
  tally.done();
  return saved;
}

export async function importNative(
  profileId: string,
  token: string | undefined,
  kinds: ("cookies" | "autofill")[],
  onFailed?: (kind: ImportKind) => void,
): Promise<Pick<ImportCounts, "cookies" | "addresses" | "cards">> {
  const none = { cookies: 0, addresses: 0, cards: 0 };
  if (!token) return none;
  const api = importModule();
  if (!kinds.length || isIncognitoProfile(profileId) || useBrowser.getState().profiles[profileId] === undefined) {
    api.discardImported(token);
    return none;
  }
  try {
    const w = await api.writeImported(token, engineProfile(useBrowser.getState(), profileId), kinds);
    if (w.cookiesFailed) onFailed?.("cookies");
    if (w.autofillFailed) onFailed?.("autofill");
    return { cookies: w.cookies, addresses: w.addresses, cards: w.cards };
  } catch {
    kinds.forEach((k) => onFailed?.(k));
    return none;
  }
}

export function openInWebStore(profileId: string, urls: string[]) {
  if (!urls.length) return;
  const windowId = windowFor(profileId);
  urls.forEach((url, i) => useBrowser.getState().newTab(windowId, { url, profileId, background: i > 0 }));
}

export function importFavorites(profileId: string, tabs: ImportedTab[], favicons?: ImportedFavicon[]): number {
  if (!tabs.length) return 0;
  importFavicons(profileId, favicons, tabs.map((t) => t.url));
  return importTabs(profileId, tabs.map((t) => ({ ...t, pinned: true })), null, "tiles");
}

export function importDiaProfile(profileId: string, profile: DiaTabsProfile, what: { pinned: boolean; open: boolean }, favicons?: ImportedFavicon[]): number {
  importFavicons(profileId, favicons, [...(what.pinned ? profile.pinned : []), ...(what.open ? profile.tabs : [])].map((t) => t.url));
  const have = openPages(useBrowser.getState(), profileId);
  const fresh = (tabs: ImportedTab[]) => tabs.filter((t) => !have.has(pageKey(t.url)));
  let n = what.pinned ? importTabs(profileId, fresh(profile.pinned), null) : 0;
  if (what.open) n += importTabs(profileId, fresh(profile.tabs).map((t) => ({ ...t, pinned: false })), "Imported");
  return n;
}

export async function applyResult(
  profileId: string,
  result: ImportResult,
  browserName: string,
  requested: ImportKind[],
  onFailed?: (kind: ImportKind) => void,
): Promise<ImportCounts> {
  const toolbar = (result.bookmarks?.children ?? []).filter((c) => c.role === "toolbar");
  importFavicons(profileId, result.favicons, [...result.favorites.map((t) => t.url), ...(result.spaces.length ? [] : result.tabs.map((t) => t.url)), ...linksOf(toolbar)]);
  const counts = emptyCounts();
  counts.bookmarks += importBookmarks(profileId, result.bookmarks, browserName);
  if (result.history.length) counts.history += importHistory(profileId, result.history);
  const native = (["cookies", "autofill"] as const).filter((k) => requested.includes(k));
  Object.assign(counts, await importNative(profileId, result.vaultToken, native, onFailed));
  if (result.tabs.length && !result.spaces.length) counts.tabs += importTabs(profileId, result.tabs, "Imported");
  if (result.favorites.length) counts.tabs += importTabs(profileId, result.favorites.map((t) => ({ ...t, pinned: true })), null, "tiles");
  if (result.credentials.length) counts.passwords += await importPasswords(profileId, result.credentials);
  return counts;
}

export async function applySafari(profileId: string, data: SafariExport, cookies = true, onFailed?: (kind: ImportKind) => void): Promise<ImportCounts> {
  const counts = emptyCounts();
  counts.bookmarks = importBookmarks(profileId, data.bookmarks, "Safari");
  const history = data.profiles.find((p) => !p.name)?.history ?? data.profiles[0]?.history ?? [];
  counts.history = importHistory(profileId, history);
  Object.assign(counts, await importNative(profileId, data.vaultToken, cookies ? ["cookies", "autofill"] : ["autofill"], onFailed));
  if (data.tabs.length) counts.tabs += importTabs(profileId, data.tabs, "Imported");
  counts.passwords = await importPasswords(profileId, data.credentials);
  return counts;
}

export function profileColorFor(hex: string | undefined): ProfileColor | undefined {
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
  return w && w.kind !== "private" ? w.profileId : s.settings.defaultProfileId;
}

export function adoptSpaceIdentity(profileId: string, space: Pick<SpaceSuggestion, "name" | "color" | "emoji">): boolean {
  const s = useBrowser.getState();
  const profile = s.profiles[profileId];
  const name = space.name.trim();
  const untouched =
    profileId === DEFAULT_PROFILE.id &&
    profile?.name === DEFAULT_PROFILE.name &&
    profile.color === DEFAULT_PROFILE.color &&
    profile.icon == null &&
    !profile.theme;
  if (!profile || !untouched || !name || s.profileOrder.length !== 1) return false;
  s.updateProfile(profileId, { name, icon: space.emoji ?? null });
  const color = profileColorFor(space.color);
  if (color) s.setProfileLook(profileId, { color });
  return true;
}

export function profileNamed(name: string): string | undefined {
  const s = useBrowser.getState();
  return s.profileOrder.find((id) => s.profiles[id]!.name.trim().toLowerCase() === name.trim().toLowerCase());
}
