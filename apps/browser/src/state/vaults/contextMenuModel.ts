import type {
  VaultContextChoice,
  VaultContextField,
  VaultContextLogin,
  VaultContextMenu,
  VaultFillField,
  VaultItem,
  VaultPasswordStyle,
  VaultProviderState,
} from "../../platform/vaults";
import { GENERATOR_STYLES, SUGGEST_EVERYTHING, type VaultSuggest } from "./menuModel";
import { isSecureOrigin, itemKey, matchTier, rankItems, siteLabel, TIER } from "./originMatch";

export const MAX_CONTEXT_LOGINS = 8;

export const CONTEXT_NOTES = {
  insecure: "Not Available on This Page",
  noLogins: "No Logins for This Site",
  noManager: "No Saved Logins",
} as const;

const CONTEXT_GENERATOR_TITLES: Record<VaultPasswordStyle, string> = {
  strong: "Strong Password",
  alphanumeric: "Strong Password Without Special Characters",
  easyToType: "Easy-to-Type Password",
  passphrase: "Memorable Password",
};

type ContextMenuInput = {
  origin: string;
  providers: readonly VaultProviderState[];
  items: readonly VaultItem[];
  remembered: string | null;
  suggest?: VaultSuggest;
};

function siteOf(item: VaultItem, origin: string): string {
  const url = item.urls.find((u) => matchTier(origin, u) > TIER.none) ?? item.urls[0];
  return url ? siteLabel(url) : "";
}

function choicesOf(item: VaultItem, suggest: VaultSuggest): VaultContextChoice[] {
  const choices: VaultContextChoice[] = [];
  if (suggest.logins && item.username.trim()) choices.push("username");
  if (suggest.logins) choices.push("password");
  if (suggest.codes && item.hasTotp === true) choices.push("otp");
  return choices;
}

export function loginTitles(items: readonly VaultItem[], origin: string, providers: readonly VaultProviderState[], marked: (item: VaultItem) => string = () => ""): string[] {
  const names = new Map(providers.map((p) => [p.id, p.name]));
  const plain = items.map((item) => {
    const who = item.username.trim() || item.title.trim();
    const site = siteOf(item, origin);
    return `${site && site !== who ? `${who} · ${site}` : who || site}${marked(item)}`;
  });
  return plain.map((title, i) => (plain.indexOf(title) !== plain.lastIndexOf(title) ? `${title} (${names.get(items[i]!.provider) ?? items[i]!.provider})` : title));
}

export function contextMenuModel(input: ContextMenuInput): VaultContextMenu {
  const suggest = input.suggest ?? SUGGEST_EVERYTHING;
  const unlocked = new Set(input.providers.filter((p) => p.state === "unlocked").map((p) => p.id));
  const unlock = input.providers.some((p) => p.state === "locked");
  if (!isSecureOrigin(input.origin)) return { logins: [], unlock: false, other: false, note: CONTEXT_NOTES.insecure };
  if (!unlock && !unlocked.size) return { logins: [], unlock: false, other: false, note: CONTEXT_NOTES.noManager };
  const offered = input.items.filter((i) => unlocked.has(i.provider) && choicesOf(i, suggest).length > 0);
  const ranked = rankItems(offered, input.origin, input.remembered).slice(0, MAX_CONTEXT_LOGINS).map((r) => r.item);
  const titles = loginTitles(ranked, input.origin, input.providers);
  const logins: VaultContextLogin[] = ranked.map((item, i) => ({ key: itemKey(item), title: titles[i]!, fields: choicesOf(item, suggest) }));
  const other = unlocked.size > 0;
  return { logins, unlock, other, note: logins.length || !other ? null : CONTEXT_NOTES.noLogins };
}

export const fillFieldOf = (choice: VaultContextChoice): VaultFillField => (choice === "otp" ? "totp" : choice);

export function pickedFillFields(field: Pick<VaultContextField, "kind" | "guess">): VaultFillField[] {
  if (field.kind === "otp") return ["totp"];
  if (field.kind === "username" || field.kind === "password") return ["username", "password"];
  return [fillFieldOf(field.guess)];
}

export const menuFieldOf = (field: Pick<VaultContextField, "kind" | "guess">) =>
  field.kind === "username" || field.kind === "password" || field.kind === "otp" ? field.kind : field.guess;

type ContextMenuOptions = { autofill: boolean; generate: { style: VaultPasswordStyle; title: string }[]; generateAnyField: boolean };

export function contextMenuOptions(suggest: VaultSuggest, anyField: boolean): ContextMenuOptions {
  const generators = suggest.newPasswords ? GENERATOR_STYLES.map((style) => ({ style, title: CONTEXT_GENERATOR_TITLES[style] })) : [];
  return { autofill: suggest.logins || suggest.codes, generate: generators, generateAnyField: generators.length > 0 && anyField };
}
