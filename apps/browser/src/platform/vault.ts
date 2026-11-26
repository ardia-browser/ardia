import { call, on, type VaultLoginFormSeen } from "@ardia/ardiacore";

export type { VerificationCodeSetupResult, VaultAlwaysGrant, VaultAuthentication, VaultLoginFormSeen, VaultSignIn, VaultSignInStatus, VaultStoreState } from "@ardia/ardiacore";

export const vaultState = () => call("vault.state");
export const screenLocked = () => call("vault.screenLocked");
export const vaultSignIn = (profile: string, url: string, origin: string, username: string, attempt: string) => call("vault.signIn", { profile, url, origin, username, attempt });
export const cancelVaultSignIn = (attempt: string) => call("vault.cancelSignIn", { attempt });
export const warmVault = () => call("vault.warm");
export const saveVaultSecret = (profile: string, origin: string, username: string, uri: string) => call("vault.saveSecret", { profile, origin, username, uri });
export const keepOfferedCode = (profile: string, tab: string, token: string, generation: number, origin: string, usernames: string[]) => call("vault.keepOfferedCode", { profile, tab, token, generation, origin, usernames });
export const hasVaultSecret = (profile: string, origin: string, username: string) => call("vault.hasSecret", { profile, origin, username });
export const vaultSecrets = (profile: string) => call("vault.secrets", { profile });
export const removeVaultSecret = (profile: string, origin: string, username: string) => call("vault.removeSecret", { profile, origin, username });
export const vaultAlwaysGrants = () => call("vault.always");
export const setVaultAlways = (profile: string, origin: string, teamId: string, identifier: string, program: string, on: boolean) => call("vault.setAlways", { profile, origin, teamId, identifier, program, on });
export const authenticateDeviceOwner = (id: string, reason: string) => call("vault.authenticate", { id, reason });
export const cancelDeviceOwnerCheck = (id: string) => call("vault.cancelAuthenticate", { id });
export const appendVaultLog = (lines: string[]) => call("vault.appendLog", { lines });
export const readVaultLog = (limit: number) => call("vault.readLog", { limit });
export const onLoginFormSeen = (listener: (form: VaultLoginFormSeen) => void) => on("vault.loginFormSeen", listener);
export const onCodeKept = (listener: (kept: { profile: string; origin: string; username: string }) => void) => on("vault.codeKept", listener);
