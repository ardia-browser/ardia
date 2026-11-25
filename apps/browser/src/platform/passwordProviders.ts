import { call, type FieldProviderHint, type FieldProviderOpened, type FieldProviderProfile, type VerificationCodeFound } from "@ardia/ardiacore";

export type { FieldProviderHint, FieldProviderOpened, VerificationCodeFound };
type FieldProvider = FieldProviderProfile;

const PROVIDER_SESSION = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");

export async function setFieldProviders(generation: number, profiles: FieldProvider[]): Promise<{ applied: boolean; answered: boolean }> {
  const reply: { applied?: unknown } | null = await call("passwords.setFieldProviders", { generation, profiles, session: PROVIDER_SESSION });
  return { applied: reply?.applied === true, answered: typeof reply?.applied === "boolean" };
}
export const showSystemPanel = (tab: string, generation: number) => call("passwords.showSystemPanel", { tab, generation });
export const showPanelHint = (tab: string, label: string, side: "above" | "below") => call("passwords.showPanelHint", { tab, label, side });
export const setUpVerificationCode = (tab: string, token: string, generation: number) => call("passwords.setUpVerificationCode", { tab, token, generation });
