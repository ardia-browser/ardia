import { goToSettingsPane, type SettingsPlace } from "../../browser/src/state/settings/settingsWindows";
import { findSetting, PANES } from "../../browser/src/components/settings/settingsIndex";
import { dropSettingsSearch, revealSettingRow } from "../../browser/src/state/settings/searchState";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice";
import { setPreferredImportSource } from "./settingsWindows";

const CONSUMED_REVEALS = "ardia.utility.consumedReveals";
const KEPT_REVEALS = 20;
const consumedInMemory: string[] = [];

function persistedReveals(): string[] {
  try {
    const saved = globalThis.sessionStorage?.getItem(CONSUMED_REVEALS);
    const parsed: unknown = saved ? JSON.parse(saved) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function consumedReveals(): string[] {
  const merged = persistedReveals();
  for (const id of consumedInMemory) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

function consumeReveal(revealId: string): boolean {
  const consumed = consumedReveals();
  if (consumed.includes(revealId)) return false;
  const kept = [...consumed, revealId].slice(-KEPT_REVEALS);
  consumedInMemory.splice(0, consumedInMemory.length, ...kept);
  try {
    globalThis.sessionStorage?.setItem(CONSUMED_REVEALS, JSON.stringify(kept));
  } catch {}
  return true;
}

export function navigateUtility(value: unknown) {
  if (!value || typeof value !== "object") return;
  const place = value as SettingsPlace;
  const importSource = (value as { importSource?: unknown }).importSource;
  if (typeof importSource === "string") setPreferredImportSource(importSource);
  if (!PANES.some((pane) => pane.id === place.pane)) return;
  goToSettingsPane(place.pane, typeof place.profileId === "string" ? place.profileId : null, typeof place.detail === "string" ? place.detail : null);
  const { reveal, revealId, revealConsent } = value as { reveal?: unknown; revealId?: unknown; revealConsent?: unknown };
  if (typeof reveal !== "string" || findSetting(reveal)?.pane !== place.pane) return;
  if (typeof revealId !== "string" || revealId.length > 64 || !consumeReveal(revealId)) return;
  const consent = typeof revealConsent === "string" && revealConsent ? (revealConsent as ConsentToken) : null;
  dropSettingsSearch(consent);
  revealSettingRow(reveal, consent);
}
