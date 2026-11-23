import type { VaultAddTotpResult, VaultCodeFound, VaultCodeLogin, VaultCodeMenu, VaultItem, VaultProviderState } from "../../platform/vaults";
import { CONTEXT_NOTES, loginTitles, MAX_CONTEXT_LOGINS } from "./contextMenuModel";
import { isSecureOrigin, itemKey, rankItems, sameUsername } from "./originMatch";

export const CODE_NOTES = {
  insecure: CONTEXT_NOTES.insecure,
  noLogins: CONTEXT_NOTES.noLogins,
  noManager: "No Password Manager Can Store Codes",
} as const;

export const CODE_TEXT = {
  gone: "This login is no longer in your password manager.",
  failed: "Couldn't add the verification code. Try again.",
  noRect: "Other Logins isn't available in this frame.",
  expired: "This code expired. Right-click it again.",
  invalid: "This isn't a verification code Ardia can use.",
} as const;

type CodeMenuInput = {
  origin: string;
  account: string;
  providers: readonly VaultProviderState[];
  items: readonly VaultItem[];
  remembered: string | null;
};

export const canHoldCode = (provider: Pick<VaultProviderState, "capabilities">) => provider.capabilities.addTotp === true;

export function codeHeader(code: Pick<VaultCodeFound, "issuer" | "account">): string {
  const issuer = code.issuer.trim();
  const account = code.account.trim();
  if (!issuer) return account;
  if (!account || issuer.toLowerCase() === account.toLowerCase()) return issuer;
  return `${issuer}: ${account}`;
}

export const loginName = (item: Pick<VaultItem, "username" | "title">) => item.username.trim() || item.title.trim() || "this login";

export function codeMenuModel(input: CodeMenuInput): VaultCodeMenu {
  if (!isSecureOrigin(input.origin)) return { logins: [], unlock: false, other: false, note: CODE_NOTES.insecure };
  const holders = input.providers.filter(canHoldCode);
  const unlocked = new Set(holders.filter((p) => p.state === "unlocked").map((p) => p.id));
  const unlock = holders.some((p) => p.state === "locked");
  if (!unlocked.size && !unlock) return { logins: [], unlock: false, other: false, note: CODE_NOTES.noManager };
  const items = input.items.filter((i) => unlocked.has(i.provider));
  const ranked = rankItems(items, input.origin, input.remembered).map((r) => r.item);
  const account = input.account.trim();
  const named = account ? [...ranked.filter((i) => sameUsername(i.username, account)), ...ranked.filter((i) => !sameUsername(i.username, account))] : ranked;
  const shown = named.slice(0, MAX_CONTEXT_LOGINS);
  const titles = loginTitles(shown, input.origin, input.providers, (item) => (item.hasTotp === true ? " (Has Code)" : ""));
  const logins: VaultCodeLogin[] = shown.map((item, i) => ({ key: itemKey(item), title: titles[i]! }));
  const other = unlocked.size > 0;
  return { logins, unlock, other, note: logins.length || !other ? null : CODE_NOTES.noLogins };
}

export const replaceQuestion = (item: VaultItem, managerName: string, code: Pick<VaultCodeFound, "issuer" | "account">) => {
  const header = codeHeader(code);
  return {
    title: `Replace the verification code for ${loginName(item)}?`,
    message: `${loginName(item)} already has a verification code in ${managerName}. ${header ? `The one for ${header}` : "The new one"} takes its place.`,
    confirmTitle: "Replace",
  };
};

export const addedLine = (item: Pick<VaultItem, "username" | "title">) => `Verification code added to ${loginName(item)}`;

export function addTotpErrorText(result: Pick<VaultAddTotpResult, "error" | "message">, managerName: string): string {
  switch (result.error) {
    case "locked":
      return `${managerName} is locked. Unlock it and try again.`;
    case "notFound":
      return `This login is no longer in ${managerName}.`;
    case "unsupported":
      return `${managerName} can't store verification codes from Ardia.`;
    case "expired":
      return CODE_TEXT.expired;
    case "invalid":
      return CODE_TEXT.invalid;
    default:
      return result.message?.trim() || `Couldn't add the verification code to ${managerName}. Try again.`;
  }
}
