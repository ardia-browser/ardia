import { hostOf } from "@ardia/core";
import { hasVaultSecret, keepOfferedCode, removeVaultSecret, saveVaultSecret, vaultSecrets, vaultState, type VaultStoreState, type VerificationCodeSetupResult } from "../../platform/vault";
import { listPasswords } from "./passwords";
import { originOfLogin } from "./savedPasswords";
import { noteVaultCodeKept } from "../telemetry/vaultCounts";
import type { ConsentToken } from "../telemetry/choice";

export const KEEPER_APP = "Ardia";

export const vaultStoreState = () => vaultState();

const loginOrigin = (origin: string) => originOfLogin(origin).toLowerCase();

export async function saveVerificationSecret(profile: string, origin: string, username: string, otpauthUri: string, consent?: ConsentToken | null): Promise<boolean> {
  const site = loginOrigin(origin);
  if (!site || !username) return false;
  const saved = (await saveVaultSecret(profile, site, username, otpauthUri)).saved;
  if (saved) noteVaultCodeKept(consent);
  return saved;
}

export const hasVerificationSecret = (profile: string, origin: string, username: string) => hasVaultSecret(profile, loginOrigin(origin), username);

export const verificationSecrets = (profile: string) => vaultSecrets(profile);

export const removeVerificationSecret = (profile: string, origin: string, username: string) => removeVaultSecret(profile, loginOrigin(origin), username);

export async function keepVerificationCode(profile: string, tabId: string, token: string, generation: number, pageUrl: string, consent: ConsentToken | null): Promise<VerificationCodeSetupResult> {
  const origin = loginOrigin(pageUrl);
  if (!origin || !hostOf(pageUrl)) return { opened: false, reason: "noTab" };
  const usernames = (await listPasswords(profile).catch(() => [])).filter((p) => loginOrigin(p.origin) === origin).map((p) => p.username);
  const result = await keepOfferedCode(profile, tabId, token, generation, origin, usernames);
  if (result.kept) noteVaultCodeKept(consent);
  return result;
}

export const vaultProblemText = (state: VaultStoreState | null) =>
  state?.problem === "unrecoverable" || state?.problem === "unreadable"
    ? "Verification codes saved before can't be read on this Mac (the vault's key stays on the Mac that made it). Set them up again from each site."
    : state?.problem === "unavailable"
      ? "This Mac has no Secure Enclave, so Ardia can't keep verification codes here."
      : null;
