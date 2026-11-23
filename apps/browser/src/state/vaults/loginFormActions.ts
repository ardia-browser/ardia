import { consentToken } from "../telemetry/choice";
import { copyVaultCode, createArdiaLogin, dropPasswordDraft, editVaultLogin, newPasswordDraft, type VaultCreateLoginResult, type VaultEditResult, type VaultLoginEdit, type VaultPasswordStyle } from "../../platform/vaults";
import { noteStandaloneCodeCopied } from "../telemetry/vaultCounts";

export type PasswordDraft = { token: string; length: number };

export const startPasswordDraft = (style?: VaultPasswordStyle): Promise<PasswordDraft | null> => newPasswordDraft(style).catch(() => null);

export const endPasswordDraft = (token: string) => void dropPasswordDraft(token).catch(() => undefined);

export const saveNewArdiaLogin = (login: { website: string; username: string; passwordDraft: string; profile: string; codeToken?: string }): Promise<VaultCreateLoginResult | null> =>
  createArdiaLogin(login).catch(() => null);

export const saveLoginEdit = (provider: string, id: string, edit: VaultLoginEdit): Promise<VaultEditResult | null> => editVaultLogin(provider, id, edit).catch(() => null);

export async function copyStandaloneCode(id: string): Promise<"copied" | "failed"> {
  const consent = consentToken();
  const result = await copyVaultCode("ardia", id).catch(() => null);
  if (!result?.copied) return "failed";
  noteStandaloneCodeCopied(consent);
  return "copied";
}
