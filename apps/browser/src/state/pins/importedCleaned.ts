import { isIncognitoSpace } from "../browser/model";
import type { BrowserState } from "../browser/store";
import type { ClosedTab } from "../browser/types";
import { keptCleanedTabs } from "./closedTabs";
import { MAX_CLEANED } from "./tabCleanup";

export const cleanedKey = (c: ClosedTab) => `${c.tab.spaceId}\u0001${c.tab.url}\u0001${c.tab.lastActiveAt ?? ""}`;

export const keptCleanedKeys = (s: Pick<BrowserState, "cleanedTabs">) => new Set(keptCleanedTabs(s.cleanedTabs).map(cleanedKey));

export type ImportedCleaned = { cleanedTabs: ClosedTab[]; added: number; already: number };

export function withImportedCleaned(s: Pick<BrowserState, "cleanedTabs" | "spaces">, entries: ClosedTab[]): ImportedCleaned {
  const kept = keptCleanedTabs(s.cleanedTabs);
  const have = keptCleanedKeys(s);
  const fresh: ClosedTab[] = [];
  let already = 0;
  for (const e of entries) {
    if (isIncognitoSpace(e.tab.spaceId) || !s.spaces[e.tab.spaceId]) continue;
    const key = cleanedKey(e);
    if (have.has(key)) already += 1;
    else {
      have.add(key);
      fresh.push(e);
    }
  }
  if (!fresh.length) return { cleanedTabs: s.cleanedTabs, added: 0, already };
  const cleanedTabs = [...kept, ...fresh].sort((a, b) => a.closedAt - b.closedAt).slice(-MAX_CLEANED);
  const inList = new Set(cleanedTabs);
  return { cleanedTabs, added: fresh.filter((e) => inList.has(e)).length, already };
}
