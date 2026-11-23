import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";

type IconMaps = { pages: Record<string, string | null>; srcs: Record<string, string>; appearances: Record<string, [string, string]> };

export function incognitoClosed(key: string): boolean {
  if (!isIncognitoProfile(key)) return false;
  const s = useBrowser.getState();
  return !Object.values(s.windows).some((w) => w.profileId === key) && !Object.values(s.tabs).some((t) => t.profileId === key);
}

const urisOf = (icons: IconMaps) => [...Object.values(icons.pages), ...Object.values(icons.srcs), ...Object.values(icons.appearances).flat()].filter((uri): uri is string => !!uri);

export function unheldBy(kept: IconMaps[]): (uri: string) => boolean {
  const held = new Set(kept.flatMap(urisOf));
  return (uri) => !held.has(uri);
}

let lastHeld: { profiles: Record<string, IconMaps>; unheld: (uri: string) => boolean } | null = null;

export function unheldIn(profiles: Record<string, IconMaps>): (uri: string) => boolean {
  if (lastHeld?.profiles !== profiles) lastHeld = { profiles, unheld: unheldBy(Object.values(profiles)) };
  return lastHeld.unheld;
}

export function takeRequest(pending: Map<string, symbol>, uri: string, request: symbol): boolean {
  if (pending.get(uri) !== request) return false;
  pending.delete(uri);
  return true;
}
