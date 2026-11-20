import type { PasswordManagerKind } from "../site/passwordManagerChoice";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

export type PanelOpener = "badge" | "menu";
export type VerificationCodeStep = "offered" | "accepted" | "failed";

const PANEL_FIELDS: Record<PanelOpener, [shown: string, refused: string]> = {
  badge: ["password_manager_panel_opens_badge", "password_manager_panel_refused_badge"],
  menu: ["password_manager_panel_opens_menu", "password_manager_panel_refused_menu"],
};

const CODE_FIELDS: Record<VerificationCodeStep, string> = {
  offered: "verification_code_setups_offered",
  accepted: "verification_code_setups_accepted",
  failed: "verification_code_setups_failed",
};

const RECORD_FAILED = "password_manager_record_failed";

const CHOICE_FIELDS: Record<PasswordManagerKind, string> = {
  ardia: "password_manager_chose_ardia",
  none: "password_manager_chose_none",
  plugin: "password_manager_chose_plugin",
};

const FIELDS = [...Object.values(PANEL_FIELDS).flat(), ...Object.values(CODE_FIELDS), ...Object.values(CHOICE_FIELDS), RECORD_FAILED];

let counts: Record<string, number> = {};
const bump = (field: string, consent?: ConsentToken | null) => countFor(consent, () => void (counts[field] = (counts[field] ?? 0) + 1), { [field]: 1 });

export const notePasswordPanel = (opener: PanelOpener, shown: boolean) => bump(PANEL_FIELDS[opener][shown ? 0 : 1]);

export const noteVerificationCodeSetup = (step: VerificationCodeStep, consent?: ConsentToken | null) => bump(CODE_FIELDS[step], consent);

export const notePasswordManagerRecordFailed = (consent?: ConsentToken | null) => bump(RECORD_FAILED, consent);

export const notePasswordManagerChosen = (kind: PasswordManagerKind, consent?: ConsentToken | null) => bump(CHOICE_FIELDS[kind], consent);

export function takePasswordManagerCounts(): Record<string, number> {
  const taken = Object.fromEntries(FIELDS.map((field) => [field, counts[field] ?? 0]));
  counts = {};
  return taken;
}
