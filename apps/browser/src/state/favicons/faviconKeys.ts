import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { DEFAULT_PROFILE_ID } from "../settings/settings";
import { profileOpened } from "../profiles/profileLoading";
import { incognitoClosed } from "./privateLookups";

export const cacheKey = (profileId: string) => (isIncognitoProfile(profileId) ? profileId : engineProfile(useBrowser.getState(), profileId));

export function lookupOrder(profileId?: string, source?: string): string[] {
  if (profileId && !isIncognitoProfile(profileId)) return [profileId];
  const first = source && !isIncognitoProfile(source) ? [source] : [];
  return [...new Set([...(profileId ? [profileId] : []), ...first, DEFAULT_PROFILE_ID, ...useBrowser.getState().profileOrder])];
}

export const askable = (id: string) => !isIncognitoProfile(id) && profileOpened(cacheKey(id));

export const privateViewer = (profileId?: string | null) => (profileId && isIncognitoProfile(profileId) ? profileId : undefined);

const BORROWED = ">";
const borrowed = new Set<string>();

export const isBorrowed = (key: string) => key.includes(BORROWED);
export const viewerOf = (key: string) => key.split(BORROWED)[0]!;
export const sourceEngineOf = (key: string) => cacheKey(key.slice(key.indexOf(BORROWED) + 1));
const borrows = (viewer: string | undefined, id: string): viewer is string => !!viewer && isIncognitoProfile(viewer) && id !== viewer;
const borrowedKey = (viewer: string, id: string) => `${viewer}${BORROWED}${id}`;

export const askKey = (viewer: string | undefined, id: string) => (borrows(viewer, id) ? borrowedKey(viewer, id) : cacheKey(id));
export const keysFor = (viewer: string | undefined, id: string) => (borrows(viewer, id) ? [cacheKey(id), borrowedKey(viewer, id)] : [cacheKey(id)]);

export function borrowFor(key: string): boolean {
  if (incognitoClosed(viewerOf(key))) return false;
  borrowed.add(key);
  return true;
}

export const stillBorrowed = (key: string) => borrowed.has(key);
export const borrowersOf = (engine: string) => [...borrowed].filter((key) => sourceEngineOf(key) === engine);
export const anyBorrowed = () => borrowed.size > 0;
export const pendingRetries = () => peekRetries.size;

export function closeViewers(open: Set<string>): string[] {
  const gone = [...borrowed].filter((key) => !open.has(viewerOf(key)));
  for (const key of gone) {
    borrowed.delete(key);
    dropRetries((id) => id.startsWith(`${key}|`));
  }
  return gone;
}

const PEEK_RETRY_MS = [500, 2000, 8000];
const peekRetries = new Map<string, { tries: number; timer?: ReturnType<typeof setTimeout> }>();

function dropRetries(match: (id: string) => boolean) {
  for (const [id, entry] of peekRetries)
    if (match(id)) {
      clearTimeout(entry.timer);
      peekRetries.delete(id);
    }
}

export function settlePeek(key: string, pages: string[], failed: boolean, settled: () => void, retry: (page: string) => void): boolean {
  if (!isBorrowed(key)) return true;
  settled();
  if (!stillBorrowed(key)) return false;
  for (const page of pages) {
    const id = `${key}|${page}`;
    if (!failed) {
      dropRetries((other) => other === id);
      continue;
    }
    const entry = peekRetries.get(id) ?? { tries: 0 };
    peekRetries.set(id, entry);
    if (entry.tries >= PEEK_RETRY_MS.length || entry.timer) continue;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (stillBorrowed(key)) retry(page);
    }, PEEK_RETRY_MS[entry.tries++]);
  }
  return true;
}
