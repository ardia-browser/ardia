import { useEffect, useState } from "react";
import { useVaults } from "./store";
import { rankedVaultUsernames } from "./menuCaches";

export const MAX_USERNAME_SUGGESTIONS = 4;
const RANKED_USERNAMES = 12;

export function usernameCompletions(ranked: readonly string[], typed: string, limit = MAX_USERNAME_SUGGESTIONS): string[] {
  const text = typed.trim().toLowerCase();
  const matching = ranked.filter((u) => {
    const name = u.toLowerCase();
    return name !== text && name.includes(text);
  });
  const starts = matching.filter((u) => u.toLowerCase().startsWith(text));
  const rest = matching.filter((u) => !u.toLowerCase().startsWith(text));
  return [...starts, ...rest].slice(0, Math.max(0, limit));
}

export function stepCompletion(selected: number, count: number, direction: "up" | "down"): number {
  if (count <= 0) return -1;
  if (direction === "down") return selected < 0 || selected >= count - 1 ? 0 : selected + 1;
  return selected <= 0 || selected >= count ? count - 1 : selected - 1;
}

export const prefilledUsername = (current: string, ranked: readonly string[]) => (current.trim() ? current : (ranked[0] ?? current));

const NONE: string[] = [];

export function useRankedUsernames(enabled: boolean, email: boolean, profile: string | null = null): string[] {
  const [ranked, setRanked] = useState<string[]>(NONE);
  const stamp = useVaults((s) => s.itemsStamp);
  useEffect(() => {
    if (!enabled) return setRanked(NONE);
    let live = true;
    void rankedVaultUsernames(email, RANKED_USERNAMES, profile).then((items) => live && setRanked(items.map((item) => item.username.trim())));
    return () => {
      live = false;
    };
  }, [enabled, email, profile, stamp]);
  return ranked;
}
