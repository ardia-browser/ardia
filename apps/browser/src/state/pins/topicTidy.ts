import type { BrowserState } from "../browser/store";
import { siteKey } from "../groups/groupNames";
import { isRegularWindow } from "../windows/small";
import { groupByTopic, topicModelSupported, type TopicPlan, type TopicTab } from "./topicModel";
import { isLoose, tidyPlan, type TidyPlan } from "./tidy";
import { noteTidyTopicFallback } from "../telemetry/tidyTabsCounts";
import { counted, type ConsentToken } from "../telemetry/client";

const NAME_MAX = 32;

export function looseTopicTabs(s: Pick<BrowserState, "tabs" | "groups">, order: string[]): TopicTab[] {
  return order.flatMap((id) => {
    if (!isLoose(s, id, "tabs")) return [];
    const t = s.tabs[id]!;
    const home = t.pinnedUrl || t.url;
    return [{ id, title: t.title || home, host: siteKey(home) || home }];
  });
}

export function unpinnedFolderGroups(s: Pick<BrowserState, "groups">, windowId: string, profileId: string): { id: string; name: string }[] {
  return Object.values(s.groups)
    .filter((g) => !g.pinned && g.windowId === windowId && g.profileId === profileId && g.tabIds.length)
    .map((g) => ({ id: g.id, name: g.name }));
}

const trimName = (name: unknown): string | null => {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed.length ? trimmed.slice(0, NAME_MAX) : null;
};

export function validatedTopicPlan(plan: unknown, tabs: TopicTab[], groupIds: Set<string>): TidyPlan | null {
  if (!plan || typeof plan !== "object") return null;
  const known = new Set(tabs.map((t) => t.id));
  const seen = new Set<string>();
  const usedInNew = new Set<string>();
  const raw = plan as { files?: unknown; newGroups?: unknown };
  const files: TidyPlan["files"] = [];
  const newGroups: TidyPlan["newGroups"] = [];
  if (Array.isArray(raw.files)) {
    for (const entry of raw.files) {
      if (!entry || typeof entry !== "object") continue;
      const { tabId, groupId } = entry as { tabId?: unknown; groupId?: unknown };
      if (typeof tabId !== "string" || typeof groupId !== "string") continue;
      if (!known.has(tabId) || !groupIds.has(groupId) || seen.has(tabId)) continue;
      seen.add(tabId);
      files.push({ tabId, groupId });
    }
  }
  if (Array.isArray(raw.newGroups)) {
    for (const entry of raw.newGroups) {
      if (!entry || typeof entry !== "object") continue;
      const { tabIds, name } = entry as { tabIds?: unknown; name?: unknown };
      if (!Array.isArray(tabIds)) continue;
      const members = tabIds.filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id) && !usedInNew.has(id));
      const trimmed = trimName(name);
      if (members.length < 2 || !trimmed) continue;
      members.forEach((id) => {
        seen.add(id);
        usedInNew.add(id);
      });
      newGroups.push({ tabIds: members, name: trimmed });
    }
  }
  return files.length || newGroups.length ? { closes: [], files, newGroups } : null;
}

export function topicTidyPlan(s: Pick<BrowserState, "tabs" | "groups" | "windows" | "splits">, windowId: string, profileId?: string, consent?: ConsentToken | null): Promise<TidyPlan | null> {
  const w = s.windows[windowId];
  if (!isRegularWindow(w)) return Promise.resolve(null);
  const profile = profileId ?? w.profileId;
  if (!topicModelSupported()) return Promise.resolve(tidyPlan(s, windowId, profile, "tabs"));
  const order = w.tabIds.filter((id) => s.tabs[id]?.profileId === profile);
  const tabs = looseTopicTabs(s, order);
  if (!tabs.length) return Promise.resolve(null);
  const groups = unpinnedFolderGroups(s, w.id, profile);
  const fallback = () => counted(consent ?? null, () => noteTidyTopicFallback());
  return groupByTopic(tabs, groups)
    .then((plan: TopicPlan) => {
      const validated = validatedTopicPlan(plan, tabs, new Set(groups.map((g) => g.id)));
      if (!validated) {
        fallback();
        return tidyPlan(s, windowId, profile, "tabs");
      }
      return validated;
    })
    .catch(() => {
      fallback();
      return tidyPlan(s, windowId, profile, "tabs");
    });
}
