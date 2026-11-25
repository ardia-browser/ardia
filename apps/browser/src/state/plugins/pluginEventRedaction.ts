import type { Download } from "../../platform/downloads";
import { minimizedUrl, urlParts } from "../../lib/urlParts";
import type { PluginPermissions } from "../../lib/pluginManifest";
import { activeTabId } from "../browser/model";
import type { BrowserState } from "../browser/store";
import { downloadSession } from "../downloads/downloadsSlice";
import { withLiveProgress } from "../downloads/progress";
import { eligibleKind, isEligibleTab, type AutomationWindowKind } from "../automation/automationWindows";
import { iconName, isEligibleGroup } from "../automation/workspaceTree";
import { innermostGroupOf } from "../groups/groups";

export type Redaction = { full: boolean; urls: boolean };

export const redactionFor = (p: PluginPermissions): Redaction => ({ full: p.fullUrls, urls: p.tabs !== false });

const MAX_TITLE = 500;
const MAX_FILENAME = 255;
const SECRET_NAME = /token|secret|password|passwd|pwd|key|auth|session|sig|signature|code|credential/i;
const MAX_DECODES = 4;

function decodedName(raw: string): string | null {
  let name = raw.replace(/\+/g, " ");
  for (let i = 0; i < MAX_DECODES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(name);
    } catch {
      return null;
    }
    if (next === name) return name;
    name = next;
  }
  return null;
}

export function hasSecretParam(query: string): boolean {
  for (const pair of query.replace(/^\?/, "").split(/[&;]/)) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const name = decodedName(at < 0 ? pair : pair.slice(0, at));
    if (name === null || SECRET_NAME.test(name)) return true;
    if (at >= 0 && decodedName(pair.slice(at + 1)) === null) return true;
  }
  return false;
}
const CONTROL_CHARS = "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]";
const CONTROL = new RegExp(CONTROL_CHARS, "gu");
const HAS_CONTROL = new RegExp(CONTROL_CHARS, "u");

export const cleanStateText = (text: string, max: number) => text.replace(CONTROL, "").slice(0, max);

export function pluginStateUrl(url: string | null | undefined, r: Redaction): string | null {
  if (!r.urls || typeof url !== "string" || url.length > 8192) return null;
  const parts = urlParts(url);
  if (!parts || (parts.scheme !== "http" && parts.scheme !== "https") || !parts.authority || !parts.host) return null;
  const authority = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/?#]*)/.exec(url)?.[1] ?? "";
  if (authority.includes("@")) return null;
  if (HAS_CONTROL.test(url)) return null;
  if (!r.full) return minimizedUrl(url);
  const fragmentless = url.replace(/#.*$/, "");
  const query = /\?[^#]*/.exec(fragmentless)?.[0] ?? "";
  return hasSecretParam(query) ? minimizedUrl(url) : fragmentless;
}

export type TabState = { id: string; windowId: string; index: number; url: string | null; title: string | null; pinned: boolean; active: boolean; groupId: string | null; muted: boolean };

export type WindowState = { id: string; kind: AutomationWindowKind; focused: boolean; activeTabId: string | null; tabCount: number };

export type GroupState = { id: string; windowId: string; name: string; color: string; icon: string | null; collapsed: boolean; pinned: boolean; parentId: string | null; tabIds: string[] };

export type DownloadState = { id: string; state: Download["state"]; paused: boolean; dangerous: boolean; received: number; total: number; mimeType: string; filename: string; url: string | null };

type Snapshot = Pick<BrowserState, "windows" | "windowOrder" | "tabs" | "peeks" | "groups" | "ui" | "profiles" | "downloads">;

const eligibleTabIds = (s: Snapshot, windowId: string) => (s.windows[windowId]?.tabIds ?? []).filter((id) => s.tabs[id]?.windowId === windowId && isEligibleTab(s, id));

export function redactedTabs(s: Snapshot, r: Redaction): TabState[] {
  const out: TabState[] = [];
  for (const windowId of s.windowOrder) {
    if (!eligibleKind(s, windowId)) continue;
    const active = activeTabId(s as BrowserState, windowId);
    eligibleTabIds(s, windowId).forEach((id, index) => {
      const t = s.tabs[id]!;
      const url = pluginStateUrl(t.url, r);
      const group = innermostGroupOf(s.groups, id);
      out.push({
        id,
        windowId,
        index,
        url,
        title: url === null ? null : cleanStateText(t.customTitle || t.title, MAX_TITLE),
        pinned: t.pin !== null,
        active: id === active,
        groupId: group && isEligibleGroup(s, group.id) ? group.id : null,
        muted: t.muted,
      });
    });
  }
  return out;
}

export function redactedWindows(s: Snapshot): WindowState[] {
  const focused = s.ui.focusOrder.find((id) => eligibleKind(s, id) !== null) ?? null;
  return s.windowOrder.flatMap((id) => {
    const kind = eligibleKind(s, id);
    if (!kind) return [];
    const active = activeTabId(s as BrowserState, id) ?? null;
    const tabs = eligibleTabIds(s, id);
    return [{ id, kind, focused: id === focused, activeTabId: active && tabs.includes(active) ? active : null, tabCount: tabs.length }];
  });
}

export function redactedGroups(s: Snapshot): GroupState[] {
  return Object.values(s.groups)
    .filter((g) => isEligibleGroup(s, g.id))
    .map((g) => ({
      id: g.id,
      windowId: g.windowId,
      name: cleanStateText(g.name, MAX_TITLE),
      color: g.color ?? "neutral",
      icon: iconName(g.icon),
      collapsed: g.collapsed,
      pinned: g.pinned,
      parentId: g.parentId && isEligibleGroup(s, g.parentId) ? g.parentId : null,
      tabIds: g.tabIds.filter((id) => isEligibleTab(s, id)),
    }));
}

const baseName = (name: string) => name.split(/[/\\]/).pop() ?? "";

export function redactedDownloads(s: Snapshot, r: Redaction): DownloadState[] {
  return withLiveProgress(s.downloads)
    .filter((d) => !d.offTheRecord && downloadSession(s, d) === null)
    .map((d) => ({
      id: d.id,
      state: d.state,
      paused: d.paused,
      dangerous: d.dangerous === true,
      received: Number.isFinite(d.received) ? d.received : 0,
      total: Number.isFinite(d.total) ? d.total : 0,
      mimeType: cleanStateText(d.mimeType ?? "", 128),
      filename: cleanStateText(baseName(d.filename ?? ""), MAX_FILENAME),
      url: pluginStateUrl(d.url, r),
    }));
}
