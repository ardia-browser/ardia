import type { StateTopic } from "../../lib/pluginState";
import type { BrowserState } from "../browser/store";
import { isEligibleTab } from "../automation/automationWindows";
import type { PageCommit } from "./stateCommits";
import type { Item } from "./stateEventPacking";
import { cleanStateText, pluginStateUrl, redactedDownloads, redactedGroups, redactedTabs, redactedWindows, type Redaction } from "./pluginEventRedaction";

export type SnapshotTopic = Exclude<StateTopic, "navigation">;
export type Sent = Map<string, string>;
export type Rows = Map<string, unknown>;
export type Diff = { changed: [string, unknown][]; removed: string[]; before: Sent | undefined; signatures: Sent };

export const REMOVED = "\u0000removed:";

function projected(cache: Map<string, Rows>, key: string, make: () => [string, unknown][]): Rows {
  let hit = cache.get(key);
  if (!hit) cache.set(key, (hit = new Map(make())));
  return hit;
}

const levelOf = (r: Redaction) => (r.urls ? (r.full ? "full" : "short") : "none");

export function rowsOf(topic: SnapshotTopic, s: BrowserState, r: Redaction, cache: Map<string, Rows>): Rows {
  switch (topic) {
    case "tabs":
      return projected(cache, `tabs:${levelOf(r)}`, () => redactedTabs(s, r).map((t) => [t.id, t]));
    case "workspace":
      return projected(cache, "workspace", () => [...redactedWindows(s).map((w): [string, unknown] => [`w:${w.id}`, w]), ...redactedGroups(s).map((g): [string, unknown] => [`g:${g.id}`, g])]);
    case "downloads":
      return projected(cache, `downloads:${levelOf(r)}`, () => redactedDownloads(s, r).map((d) => [d.id, d]));
  }
}

export function diffRows(before: Sent | undefined, rows: Rows): Diff {
  const signatures: Sent = new Map();
  const changed: [string, unknown][] = [];
  for (const [id, row] of rows) {
    const sig = JSON.stringify(row);
    signatures.set(id, sig);
    if (before?.get(id) !== sig) changed.push([id, row]);
  }
  const removed = before ? [...before.keys()].filter((id) => !signatures.has(id)) : [];
  return { changed, removed, before, signatures };
}

export function itemsFor(diff: Diff, topic: SnapshotTopic): { fields: string[]; items: Item[] } {
  const removedItems = (prefix: string, field: string): Item[] => diff.removed.filter((id) => id.startsWith(prefix)).map((id) => ({ key: REMOVED + id, field, value: id.slice(prefix.length) }));
  if (topic === "workspace") {
    return {
      fields: ["windows", "groups", "removedWindows", "removedGroups"],
      items: [
        ...diff.changed.filter(([id]) => id.startsWith("w:")).map(([key, value]) => ({ key, field: "windows", value })),
        ...diff.changed.filter(([id]) => id.startsWith("g:")).map(([key, value]) => ({ key, field: "groups", value })),
        ...removedItems("w:", "removedWindows"),
        ...removedItems("g:", "removedGroups"),
      ],
    };
  }
  return { fields: [topic, "removed"], items: [...diff.changed.map(([key, value]) => ({ key, field: topic, value })), ...removedItems("", "removed")] };
}

export function commitItems(s: BrowserState, commits: PageCommit[], r: Redaction): Item[] {
  return commits.flatMap((c) => {
    const t = s.tabs[c.tabId];
    if (!t || !isEligibleTab(s, c.tabId)) return [];
    const url = pluginStateUrl(c.url, r);
    if (url === null) return [];
    const title = t.url === c.url ? cleanStateText(t.customTitle || t.title, 500) : null;
    return [{ key: null, field: "commits", value: { tabId: c.tabId, windowId: t.windowId, url, title, sameDocument: c.sameDocument }, tag: c.consent }];
  });
}
