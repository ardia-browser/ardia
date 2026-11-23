import type { AutofillFieldKind, AutofillFieldPart, SavedAddress, SavedCard } from "../../platform/autofill";
import { addressDetail, addressTitle, firstStreetLine } from "./addresses";
import { cardExpiry, cardsInOrder, cardTitle } from "./cards";

export type AutofillRow =
  | { key: string; kind: "address"; address: SavedAddress; title: string; detail: string }
  | { key: string; kind: "card"; card: SavedCard; title: string; detail: string; expired: boolean }
  | { key: string; kind: "manage"; what: AutofillFieldKind };

export type AutofillMenuInput = {
  kind: AutofillFieldKind;
  part: AutofillFieldPart;
  addresses: readonly SavedAddress[];
  cards: readonly SavedCard[];
  enabled: { addresses: boolean; cards: boolean };
  now: Date;
};

const ADDRESS_PARTS = new Set<AutofillFieldPart>(["name", "organization", "street", "city", "state", "postalCode", "country", "phone", "email"]);

function addressValue(a: SavedAddress, part: AutofillFieldPart): string {
  if (part === "street") return firstStreetLine(a.street);
  if (!ADDRESS_PARTS.has(part)) return "";
  return (a[part as keyof SavedAddress] as string | undefined)?.trim() ?? "";
}

const sameContent = (a: SavedAddress, b: SavedAddress) =>
  (["name", "organization", "street", "city", "state", "postalCode", "country", "phone", "email"] as const).every((k) => (a[k] ?? "").trim() === (b[k] ?? "").trim());

function addressRows(input: AutofillMenuInput): AutofillRow[] {
  const kept: SavedAddress[] = [];
  for (const a of input.addresses) if (addressValue(a, input.part) && !kept.some((k) => sameContent(k, a))) kept.push(a);
  return kept.map((a) => {
    const title = addressValue(a, input.part);
    const who = addressTitle(a);
    const detail = input.part === "street" ? [who === title ? "" : who, a.city?.trim() ?? ""].filter(Boolean).join(", ") : who !== title ? who : addressDetail(a);
    return { key: `address:${a.id}`, kind: "address", address: a, title, detail };
  });
}

function cardRows(input: AutofillMenuInput): AutofillRow[] {
  return cardsInOrder(input.cards, input.now).map((card) => {
    const expiry = cardExpiry(card, input.now);
    const when = expiry.label ? (expiry.expired ? `Expired ${expiry.label}` : expiry.label) : "";
    return { key: `card:${card.id}`, kind: "card", card, title: cardTitle(card), detail: [card.name?.trim() ?? "", when].filter(Boolean).join(" · "), expired: expiry.expired };
  });
}

export function autofillMenuRows(input: AutofillMenuInput): AutofillRow[] {
  const on = input.kind === "card" ? input.enabled.cards : input.enabled.addresses;
  if (!on) return [];
  const rows = input.kind === "card" ? cardRows(input) : addressRows(input);
  return rows.length ? [...rows, { key: `manage:${input.kind}`, kind: "manage", what: input.kind }] : [];
}

export const autofillRestingRow = (rows: readonly AutofillRow[]) => rows.findIndex((r) => r.kind === "address" || (r.kind === "card" && !r.expired));

export const isTouchCardRow = (row: AutofillRow | undefined): row is Extract<AutofillRow, { kind: "card" }> => row?.kind === "card";
