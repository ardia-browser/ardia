import type { FieldProviderProfile, PasswordExportStatus, SavedPassword, SystemPanelResult, VerificationCodeSetupResult } from "../../passwords";
import type { Profile } from "../wire";

export type PasswordsCalls = {
  "passwords.list": [Profile, { passwords: SavedPassword[] }];
  "passwords.unlock": [Profile, { unlocked: boolean }];
  "passwords.reveal": [Profile & { origin: string; username: string }, { password: string | null }];
  "passwords.remove": [Profile & { origin: string; username: string }, { ok: true }];
  "passwords.neverSaveOrigins": [Profile, { origins: string[] }];
  "passwords.allowSaving": [Profile & { origin: string }, { ok: true }];
  "passwords.export": [Profile, { status: PasswordExportStatus; path?: string }];
  "passwords.autofillEnabled": [Profile, boolean];
  "passwords.setAutofillEnabled": [Profile & { enabled: boolean }, null];
  "passwords.setFieldProviders": [{ session: string; generation: number; profiles: FieldProviderProfile[] }, { applied: boolean }];
  "passwords.showSystemPanel": [{ tab: string; generation?: number }, SystemPanelResult];
  "passwords.showPanelHint": [{ tab: string; label: string; side: "above" | "below" }, { shown: boolean }];
  "passwords.systemPanelAvailable": [{}, { chromium: boolean; webkit: boolean }];
  "passwords.otpauthHandler": [{}, { app: string | null }];
  "passwords.setUpVerificationCode": [{ tab: string; token: string; generation?: number }, VerificationCodeSetupResult];
};

export type PasswordsEvents = {};
