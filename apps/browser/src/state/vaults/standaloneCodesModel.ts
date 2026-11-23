import type { VaultItem, VaultStandaloneCode } from "../../platform/vaults";
import { foldForSearch, searchWordsOf } from "./originMatch";

export const CODE_ID_PREFIX = "code.";
const ARDIA = "ardia";
const BY_LABEL = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export const isCodeItem = (item: Pick<VaultItem, "provider" | "id">) => item.provider === ARDIA && item.id.startsWith(CODE_ID_PREFIX);

export const codeItem = (code: VaultStandaloneCode): VaultItem => ({
  provider: ARDIA,
  id: code.id,
  title: code.label,
  username: "",
  urls: code.website ? [code.website] : [],
  hasTotp: true,
  ...(code.period ? { totpPeriod: code.period } : {}),
});

export const sortedCodes = (codes: readonly VaultStandaloneCode[]): VaultStandaloneCode[] =>
  [...codes].sort((a, b) => BY_LABEL.compare(a.label, b.label) || BY_LABEL.compare(a.issuer ?? "", b.issuer ?? "") || (a.id < b.id ? -1 : 1));

const hayOf = (code: VaultStandaloneCode) => foldForSearch([code.label, code.issuer ?? "", code.website?.replace(/^https?:\/\//, "") ?? ""].join(" "));

export function matchingCodes(codes: readonly VaultStandaloneCode[], query: string): readonly VaultStandaloneCode[] {
  const words = searchWordsOf(query);
  if (!words.length) return codes;
  return codes.filter((code) => {
    const hay = hayOf(code);
    return words.every((w) => hay.includes(w));
  });
}

export function codeLabels(read: { issuer: string; account: string }): { label: string; issuer: string } {
  const label = read.account.trim() || read.issuer.trim();
  const issuer = read.issuer.trim();
  return { label, issuer: issuer.toLowerCase() === label.toLowerCase() ? "" : issuer };
}
