import { capture, consentNow, consentToken, counted, isSharing, onConsentPeriodChange, stillValid, type ConsentToken } from "./client";
import { appInfo } from "./transport";
import { launchFirstWindow } from "./journeys";
import type { PanelState } from "../browser/types";
import type { AutofillToggle } from "../../platform/autofill";
import type { SuggestionVia } from "@ardia/core";

export type SuggestionType = "history" | "bookmark" | "tab" | "url" | "search" | "calc" | "action" | "create" | "extension" | "provider" | "typed";

type SuggestionLike = { kind: string; id?: string; tabId?: string; bookmarked?: boolean; visited?: boolean } | undefined;

function suggestionType(s: SuggestionLike): SuggestionType {
  if (!s) return "typed";
  switch (s.kind) {
    case "page":
      return s.tabId ? "tab" : s.bookmarked ? "bookmark" : s.visited ? "history" : "url";
    case "search":
    case "calc":
    case "action":
    case "create":
    case "extension":
    case "provider":
      return s.kind;
    default:
      return "url";
  }
}

export type CommandBarPlacementLabel = "field" | "centred" | "centred_no_field" | "new_tab";

export function commandBarPlacementLabel(panel: Pick<PanelState, "newTab" | "placement">): CommandBarPlacementLabel {
  if (panel.newTab) return "new_tab";
  if (panel.placement === "centred") return "centred";
  if (panel.placement === "centredNoField") return "centred_no_field";
  return "field";
}

export const trackSuggestionChosen = (s: SuggestionLike, via?: SuggestionVia) =>
  capture("suggestion_chosen", { type: suggestionType(s), ...(s?.kind === "action" && s.id ? { command: s.id.split(":")[0] } : {}), ...(via ? { via } : {}) }, consentNow());

export type CalendarConnectReport = { before: string; after: string; responsible: string; errored: boolean; settingsOpened: boolean; ms: number };

export const trackCalendarConnect = (r: CalendarConnectReport, consent: ConsentToken | null) =>
  capture("calendar_connect", { before: r.before, after: r.after, responsible: r.responsible, errored: r.errored, settings_opened: r.settingsOpened, ms: Math.min(Math.max(0, Math.round(r.ms)), 600_000) }, consent);

export const trackSettingsSection = (section: string, openMs?: number) =>
  capture("settings_section_opened", { section, ...(openMs !== undefined && openMs >= 0 && openMs < 60_000 ? { open_ms: Math.round(openMs) } : {}) }, consentNow());
export const trackAutofillToggleKept = (toggle: AutofillToggle) => capture("autofill_toggle_kept", { toggle }, consentNow());

const SAMPLE_EVERY = 5;
const MAX_SAMPLES = 500;
const latency: number[] = [];
let keystrokes = 0;

onConsentPeriodChange(() => (keystrokes = 0));

export type OmniboxKey = { at: number; consent: ConsentToken | null };

export const newOmniboxKey = (): OmniboxKey => ({ at: 0, consent: null });

export function omniboxKeyHeard(key: OmniboxKey) {
  key.at = Date.now();
  key.consent = consentToken();
}

export function sampleOmniboxLatency(key: OmniboxKey) {
  const { at, consent } = key;
  key.at = 0;
  if (!at || !stillValid(consent) || ++keystrokes % SAMPLE_EVERY) return;
  const ms = Date.now() - at;
  if (ms >= 0 && ms < 10_000 && latency.length < MAX_SAMPLES) latency.push(ms);
}

export const takeOmniboxLatency = () => latency.splice(0);

let suggests = { search_suggest_ok: 0, search_suggest_blocked: 0, search_suggest_failed: 0 };

export const noteSearchSuggest = (outcome: "ok" | "blocked" | "failed", consent: ConsentToken | null) => counted(consent, () => void suggests[`search_suggest_${outcome}`]++);

export const takeSearchSuggests = () => {
  const taken = suggests;
  suggests = { search_suggest_ok: 0, search_suggest_blocked: 0, search_suggest_failed: 0 };
  return taken;
};

let externalAppRequests = { external_app_prompts: 0, external_app_requests_without_app: 0 };

export const noteExternalAppRequest = (hasApp: boolean) => void externalAppRequests[hasApp ? "external_app_prompts" : "external_app_requests_without_app"]++;

export const takeExternalAppRequests = () => {
  const taken = externalAppRequests;
  externalAppRequests = { external_app_prompts: 0, external_app_requests_without_app: 0 };
  return taken;
};

export { takePopupTabCounts } from "./popupTabCounts";

let firstWindowAt: number | null = null;

export function markFirstWindow() {
  if (firstWindowAt !== null) return;
  firstWindowAt = Date.now();
  const start = appInfo().processStart;
  if (!isSharing() || !start) return;
  if (firstWindowAt - start > 0 && firstWindowAt - start < 10 * 60_000) launchFirstWindow(firstWindowAt);
}

export { takeNotificationRequestCounts } from "./notificationRequestCounts";

export { takeRecentlyClosedCounts } from "./recentlyClosedCounts";

export { takeHistoryRemovalCounts } from "./historyRemovalCounts";

export const devOmniboxSampler = () => ({ keystrokes, pending: latency.length });
