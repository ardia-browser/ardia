import type { ChoiceChange, SharingSource } from "../../browser/src/state/telemetry/relay";

const SOURCES: readonly SharingSource[] = ["settings", "onboarding", "ask", "watch", "watch_ended"];
const MAX_ID = 128;

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

export function parseChoiceChange(text: string | undefined): ChoiceChange | null {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  if (!isFields(value)) return null;
  if (value.kind === "askDismissed" || value.kind === "watchStopped" || value.kind === "watchNoticeShown") return { kind: value.kind };
  if (value.kind === "installId") return isId(value.id) ? { kind: "installId", id: value.id } : null;
  if (value.kind === "watchStarted") {
    return isId(value.reportId) && typeof value.days === "number" && Number.isFinite(value.days) ? { kind: "watchStarted", reportId: value.reportId, days: value.days } : null;
  }
  if (value.kind !== "sharing" || typeof value.on !== "boolean" || !SOURCES.includes(value.source as SharingSource)) return null;
  const change: ChoiceChange = { kind: "sharing", on: value.on, source: value.source as SharingSource };
  const placement = value.placement;
  if (placement === undefined) return change;
  if (!isFields(placement) || placement.ask_place !== "new_tab_corner" || typeof placement.ask_shown_tabs !== "number" || !Number.isSafeInteger(placement.ask_shown_tabs)) return null;
  return { ...change, placement: { ask_place: "new_tab_corner", ask_shown_tabs: placement.ask_shown_tabs } };
}

export type ChoiceShown = { sharing: boolean; decided: boolean; askDone: boolean };

export function shownAfter(change: ChoiceChange): Partial<ChoiceShown> | null {
  if (change.kind === "sharing") return { sharing: change.on, decided: true, askDone: true };
  if (change.kind === "askDismissed") return { askDone: true };
  return null;
}
