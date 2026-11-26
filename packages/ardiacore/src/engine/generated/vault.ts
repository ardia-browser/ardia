import type { VerificationCodeSetupResult } from "../../passwords";
import type { VaultAlwaysGrant, VaultAuthentication, VaultLoginFormSeen, VaultSignIn, VaultStoreState } from "../../vault";
import type { Profile } from "../wire";

export type VaultCalls = {
  "vault.state": [{}, VaultStoreState];
  "vault.screenLocked": [{}, boolean];
  "vault.signIn": [Profile & { url: string; origin: string; username: string; attempt: string }, VaultSignIn];
  "vault.cancelSignIn": [{ attempt: string }, boolean];
  "vault.warm": [{}, boolean];
  "vault.saveSecret": [Profile & { origin: string; username: string; uri: string }, { saved: boolean; reason?: "unreadable" }];
  "vault.keepOfferedCode": [Profile & { tab: string; token: string; generation?: number; origin: string; usernames: string[] }, VerificationCodeSetupResult];
  "vault.hasSecret": [Profile & { origin: string; username: string }, boolean];
  "vault.secrets": [Profile, { origin: string; username: string }[]];
  "vault.removeSecret": [Profile & { origin: string; username: string }, boolean];
  "vault.always": [{}, VaultAlwaysGrant[]];
  "vault.setAlways": [Profile & { origin: string; teamId: string; identifier: string; program: string; on: boolean }, boolean];
  "vault.authenticate": [{ id: string; reason: string }, VaultAuthentication];
  "vault.cancelAuthenticate": [{ id: string }, boolean];
  "vault.appendLog": [{ lines: string[] }, boolean];
  "vault.readLog": [{ limit: number }, string[]];
};

export type VaultEvents = {
  "vault.loginFormSeen": VaultLoginFormSeen;
  "vault.codeKept": { profile: string; origin: string; username: string };
};
