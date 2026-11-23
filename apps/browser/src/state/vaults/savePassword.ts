import type { VaultPasswordDraft } from "../../platform/vaults";
import { webviews } from "../../platform/webviews";

export type { VaultPasswordDraft };

const NO_DRAFT: VaultPasswordDraft = { token: "", length: 0 };

export async function stageOfferPassword(tabId: string, origin: string): Promise<VaultPasswordDraft> {
  const web = webviews.get(tabId);
  if (!web) return NO_DRAFT;
  return (await web.stageVaultPassword({ origin }).catch(() => null)) ?? NO_DRAFT;
}

export const passwordLetsSave = (length: number | null) => length === null || length > 0;
