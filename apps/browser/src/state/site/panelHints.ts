import { readDocument, saveDocument } from "../../platform/documents";
import { showPanelHint, type FieldProviderHint, type FieldProviderOpened } from "../../platform/passwordProviders";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { currentTab } from "../browser/current";
import { siteKey } from "../groups/groupNames";
import { notePanelHint } from "../telemetry/passwordManagerCounts";

export const PANEL_HINTS_DOCUMENT = "password-panel-hints.json";
export const PANEL_HINT_DISMISSALS = 3;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

let dismissals: Record<string, number> | null = null;

function dismissalsByProfile(): Record<string, number> {
  if (dismissals) return dismissals;
  dismissals = {};
  try {
    const saved = JSON.parse(readDocument(PANEL_HINTS_DOCUMENT) ?? "null") as { dismissals?: unknown } | null;
    const stored = saved && typeof saved.dismissals === "object" && saved.dismissals ? (saved.dismissals as Record<string, unknown>) : {};
    for (const [profileId, count] of Object.entries(stored)) if (typeof count === "number" && Number.isFinite(count) && count > 0) dismissals[profileId] = Math.floor(count);
  } catch {}
  return dismissals;
}

export function panelHintLabel(url: string | undefined): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  const label = siteKey(url);
  return LABEL.test(label) ? label : null;
}

export const panelHintQuiet = (profileId: string) => (dismissalsByProfile()[profileId] ?? 0) >= PANEL_HINT_DISMISSALS;

export async function offerPanelHint(tabId: string, opened: FieldProviderOpened): Promise<boolean> {
  if (!PLATFORM_FEATURES.systemPasswordManagers || opened?.shown !== true || (opened.panel !== "above" && opened.panel !== "below")) return false;
  const tab = currentTab(tabId);
  const label = panelHintLabel(tab?.url);
  if (!tab || !label || panelHintQuiet(tab.profileId)) return false;
  const reply = await showPanelHint(tabId, label, opened.panel === "below" ? "above" : "below").catch(() => null);
  return reply?.shown === true;
}

export function panelHintReported(tabId: string, hint: FieldProviderHint) {
  if (hint?.state !== "shown" && hint?.state !== "dismissed") return;
  notePanelHint(hint.state);
  const profileId = currentTab(tabId)?.profileId;
  if (hint.state !== "dismissed" || !profileId) return;
  const counts = dismissalsByProfile();
  counts[profileId] = (counts[profileId] ?? 0) + 1;
  saveDocument(PANEL_HINTS_DOCUMENT, JSON.stringify({ version: 1, dismissals: counts }));
}

export const forgetPanelHintsForTests = () => void (dismissals = null);
