import type { ApplePasswordsPairing, ApplePasswordsSaveCount, LoginListCount, LoginListEngine } from "../../platform/applePasswords";
import type { FieldProviderOpened } from "../../platform/passwordProviders";
import type { PasswordManagerKind } from "../site/passwordManagerChoice";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

type PanelOpener = "badge" | "menu";
type PanelRefusal = NonNullable<FieldProviderOpened["reason"]>;
type VerificationCodeStep = "offered" | "accepted" | "failed";

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

const ME_CARD_FIELDS: Record<"on" | "refused", string> = {
  on: "me_card_turned_on",
  refused: "me_card_access_refused",
};

type OnboardingOffer = "applePasswords" | "meCard";
const OFFER_FIELDS: Record<OnboardingOffer, Record<"accepted" | "declined", string>> = {
  applePasswords: { accepted: "onboarding_offers_apple_passwords_accepted", declined: "onboarding_offers_apple_passwords_declined" },
  meCard: { accepted: "onboarding_offers_me_card_accepted", declined: "onboarding_offers_me_card_declined" },
};

const ICLOUD_EXTENSION_FIELDS: Record<"turnedOff" | "turnedBackOn" | "restored" | "failed", string> = {
  turnedOff: "icloud_extension_turned_off",
  turnedBackOn: "icloud_extension_turned_back_on",
  restored: "icloud_extension_restored",
  failed: "icloud_extension_failures",
};

const RECORD_FAILED = "password_manager_record_failed";
const MOVED_BACK = "password_manager_profiles_moved_back";
const RESTORE_FIELDS: Record<"restored" | "failed", string> = {
  restored: "password_manager_offer_to_save_restored",
  failed: "password_manager_offer_to_save_restore_failures",
};

type PanelHintStep = "shown" | "dismissed";
const HINT_FIELDS: Record<PanelHintStep, string> = {
  shown: "password_manager_panel_hints_shown",
  dismissed: "password_manager_panel_hints_dismissed",
};

const CHOICE_FIELDS: Record<PasswordManagerKind, string> = {
  ardia: "password_manager_chose_ardia",
  apple: "password_manager_chose_apple",
  none: "password_manager_chose_none",
  plugin: "password_manager_chose_plugin",
};

type PairingFailure = Exclude<ApplePasswordsPairing, "awaitingCode" | "paired">;
const PAIRING_FIELDS = { started: "apple_passwords_pairings_started", paired: "apple_passwords_pairings_paired", failed: "apple_passwords_pairings_failed" };
const PAIRING_FAILURE_FIELDS: Record<PairingFailure, string> = {
  wrongCode: "apple_passwords_pairing_failures_wrong_code",
  failed: "apple_passwords_pairing_failures_failed",
  refused: "apple_passwords_pairing_failures_refused",
  helperMissing: "apple_passwords_pairing_failures_helper_missing",
  tooOld: "apple_passwords_pairing_failures_too_old",
  notEntitled: "apple_passwords_pairing_failures_not_entitled",
};

const LOGIN_LIST_FIELDS: Record<LoginListCount, string> = {
  shown: "apple_passwords_login_list_shown",
  filled: "apple_passwords_login_list_filled",
  fillFailed: "apple_passwords_fills_failed",
  connectShown: "apple_passwords_login_list_connect_shown",
  connectPicked: "apple_passwords_login_list_connect_picked",
  notNow: "apple_passwords_login_list_not_now",
  codeFilled: "apple_passwords_codes_filled",
  codeFillFailed: "apple_passwords_codes_failed",
  strongPasswordUsed: "apple_passwords_strong_passwords_used",
};

const LOGIN_LIST_ENGINES: readonly LoginListEngine[] = ["chromium", "webkit"];
const loginListEngineField = (name: LoginListCount, engine: LoginListEngine) => `${LOGIN_LIST_FIELDS[name]}_${engine}`;
const LOGIN_LIST_ENGINE_FIELDS = (Object.keys(LOGIN_LIST_FIELDS) as LoginListCount[]).flatMap((name) => LOGIN_LIST_ENGINES.map((engine) => loginListEngineField(name, engine)));

const SAVE_FIELDS: Record<ApplePasswordsSaveCount, string> = {
  saved: "apple_passwords_saves_saved",
  saveFailed: "apple_passwords_saves_failed",
};
const saveEngineField = (name: ApplePasswordsSaveCount, engine: LoginListEngine) => `${SAVE_FIELDS[name]}_${engine}`;
const SAVE_ENGINE_FIELDS = (Object.keys(SAVE_FIELDS) as ApplePasswordsSaveCount[]).flatMap((name) => LOGIN_LIST_ENGINES.map((engine) => saveEngineField(name, engine)));

const FIELDS = [...Object.values(LOGIN_LIST_FIELDS), ...LOGIN_LIST_ENGINE_FIELDS, ...Object.values(SAVE_FIELDS), ...SAVE_ENGINE_FIELDS, ...Object.values(PAIRING_FIELDS), ...Object.values(PAIRING_FAILURE_FIELDS), ...Object.values(PANEL_FIELDS).flat(), ...Object.values(PANEL_REFUSALS), ...Object.values(HINT_FIELDS), ...Object.values(CODE_FIELDS), ...Object.values(CHOICE_FIELDS), ...Object.values(ME_CARD_FIELDS), ...Object.values(OFFER_FIELDS).flatMap(Object.values), ...Object.values(ICLOUD_EXTENSION_FIELDS), RECORD_FAILED, MOVED_BACK, ...Object.values(RESTORE_FIELDS)];

let counts: Record<string, number> = {};
const bump = (field: string, consent?: ConsentToken | null, by = 1) => countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + by));

export function notePasswordPanel(opener: PanelOpener, shown: boolean, reason?: PanelRefusal) {
  bump(PANEL_FIELDS[opener][shown ? 0 : 1]);
  if (!shown && reason && PANEL_REFUSALS[reason]) bump(PANEL_REFUSALS[reason]);
}

export const noteVerificationCodeSetup = (step: VerificationCodeStep, consent?: ConsentToken | null) => bump(CODE_FIELDS[step], consent);

export const notePasswordManagerRecordFailed = (consent?: ConsentToken | null) => bump(RECORD_FAILED, consent);

export function noteProfilesMovedBack(moved: number, consent?: ConsentToken | null) {
  if (moved > 0) bump(MOVED_BACK, consent, moved);
}

export const noteOfferToSaveRestore = (restored: boolean, consent?: ConsentToken | null) => bump(RESTORE_FIELDS[restored ? "restored" : "failed"], consent);

export const notePanelHint = (step: PanelHintStep) => bump(HINT_FIELDS[step]);

export const noteMeCardSwitch = (step: keyof typeof ME_CARD_FIELDS, consent?: ConsentToken | null) => bump(ME_CARD_FIELDS[step], consent);

export const noteOnboardingOffer = (offer: OnboardingOffer, answer: "accepted" | "declined", consent?: ConsentToken | null) => bump(OFFER_FIELDS[offer][answer], consent);

export const noteICloudExtension = (step: keyof typeof ICLOUD_EXTENSION_FIELDS, consent?: ConsentToken | null) => bump(ICLOUD_EXTENSION_FIELDS[step], consent);

export const notePasswordManagerChosen = (kind: PasswordManagerKind, consent?: ConsentToken | null) => bump(CHOICE_FIELDS[kind], consent);

export const noteApplePasswordsPairing = (step: "started" | "paired", consent: ConsentToken | null) => bump(PAIRING_FIELDS[step], consent);

export function noteApplePasswordsPairingFailed(kind: PairingFailure, consent: ConsentToken | null) {
  bump(PAIRING_FIELDS.failed, consent);
  bump(PAIRING_FAILURE_FIELDS[kind], consent);
}

function bumpWithEngine(field: string, engineField: (engine: LoginListEngine) => string, engine: string | undefined, consent: ConsentToken | null) {
  bump(field, consent);
  const known = LOGIN_LIST_ENGINES.find((each) => each === engine);
  if (known) bump(engineField(known), consent);
}

export const noteLoginList = (name: LoginListCount, engine: string | undefined, consent: ConsentToken | null) =>
  bumpWithEngine(LOGIN_LIST_FIELDS[name], (known) => loginListEngineField(name, known), engine, consent);

export const noteApplePasswordsSave = (name: ApplePasswordsSaveCount, engine: string | undefined, consent: ConsentToken | null) =>
  bumpWithEngine(SAVE_FIELDS[name], (known) => saveEngineField(name, known), engine, consent);

export function takePasswordManagerCounts(): Record<string, number> {
  const taken = Object.fromEntries(FIELDS.map((field) => [field, counts[field] ?? 0]));
  counts = {};
  return taken;
}
