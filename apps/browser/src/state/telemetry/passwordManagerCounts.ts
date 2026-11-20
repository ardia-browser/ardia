import type { FieldProviderOpened } from "../../platform/passwordProviders";
import type { PasswordManagerKind } from "../site/passwordManagerChoice";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

export type PanelOpener = "badge" | "menu";
type PanelRefusal = NonNullable<FieldProviderOpened["reason"]>;
export type VerificationCodeStep = "offered" | "accepted" | "failed";

const PANEL_FIELDS: Record<PanelOpener, [shown: string, refused: string]> = {
  badge: ["password_manager_panel_opens_badge", "password_manager_panel_refused_badge"],
  menu: ["password_manager_panel_opens_menu", "password_manager_panel_refused_menu"],
};

const PANEL_REFUSALS: Record<PanelRefusal, string> = {
  hidden: "password_manager_panel_refusal_hidden",
  notFocused: "password_manager_panel_refusal_not_focused",
  unavailable: "password_manager_panel_refusal_unavailable",
  notKey: "password_manager_panel_refusal_not_key",
  notEditing: "password_manager_panel_refusal_not_editing",
  throttled: "password_manager_panel_refusal_throttled",
  refused: "password_manager_panel_refusal_refused",
  noPanel: "password_manager_panel_refusal_no_panel",
};

const CODE_FIELDS: Record<VerificationCodeStep, string> = {
  offered: "verification_code_setups_offered",
  accepted: "verification_code_setups_accepted",
  failed: "verification_code_setups_failed",
};

const RECORD_FAILED = "password_manager_record_failed";

export type PanelHintStep = "shown" | "dismissed";
const HINT_FIELDS: Record<PanelHintStep, string> = {
  shown: "password_manager_panel_hints_shown",
  dismissed: "password_manager_panel_hints_dismissed",
};

const CHOICE_FIELDS: Record<PasswordManagerKind, string> = {
  ardia: "password_manager_chose_ardia",
  none: "password_manager_chose_none",
  plugin: "password_manager_chose_plugin",
};

const FIELDS = [...Object.values(PANEL_FIELDS).flat(), ...Object.values(PANEL_REFUSALS), ...Object.values(HINT_FIELDS), ...Object.values(CODE_FIELDS), ...Object.values(CHOICE_FIELDS), RECORD_FAILED];

let counts: Record<string, number> = {};
const bump = (field: string, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + 1));

export function notePasswordPanel(opener: PanelOpener, shown: boolean, reason?: PanelRefusal) {
  bump(PANEL_FIELDS[opener][shown ? 0 : 1]);
  if (!shown && reason && PANEL_REFUSALS[reason]) bump(PANEL_REFUSALS[reason]);
}

export const noteVerificationCodeSetup = (step: VerificationCodeStep, consent?: ConsentToken | null) => bump(CODE_FIELDS[step], consent);

export const notePasswordManagerRecordFailed = (consent?: ConsentToken | null) => bump(RECORD_FAILED, consent);

export const notePanelHint = (step: PanelHintStep) => bump(HINT_FIELDS[step]);

export const notePasswordManagerChosen = (kind: PasswordManagerKind) => bump(CHOICE_FIELDS[kind]);

export function takePasswordManagerCounts(): Record<string, number> {
  const taken = Object.fromEntries(FIELDS.map((field) => [field, counts[field] ?? 0]));
  counts = {};
  return taken;
}
