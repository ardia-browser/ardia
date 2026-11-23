import type { CardNetwork, CardNumberSummary, SavedCard } from "../../platform/autofill";

const NETWORK_NAMES: Record<CardNetwork, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  card: "Card",
};

export const cardNetworkName = (network: CardNetwork) => NETWORK_NAMES[network] ?? NETWORK_NAMES.card;

export const cardTitle = (card: Pick<SavedCard, "network" | "last4">) => `${cardNetworkName(card.network)} •••• ${card.last4}`;

const twoDigits = (n: number) => String(n % 100).padStart(2, "0");

export type CardExpiry = { label: string; expired: boolean };

export function cardExpiry(card: Pick<SavedCard, "expMonth" | "expYear">, now: Date): CardExpiry {
  const { expMonth: month, expYear: year } = card;
  if (!month || !year) return { label: "", expired: false };
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  return { label: `${twoDigits(month)}/${twoDigits(year)}`, expired: year < thisYear || (year === thisYear && month < thisMonth) };
}

export function cardsInOrder(cards: readonly SavedCard[], now: Date): SavedCard[] {
  const live = cards.filter((c) => !cardExpiry(c, now).expired);
  return live.length === cards.length ? [...cards] : [...live, ...cards.filter((c) => cardExpiry(c, now).expired)];
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

export function cardMatches(card: SavedCard, query: string): boolean {
  const hay = [cardNetworkName(card.network), card.last4, card.name ?? ""].join(" ").toLowerCase();
  return words(query).every((w) => hay.includes(w));
}

export type CardFormProblem = "number" | "expiry";

type CardFormState = { isNew: boolean; number: CardNumberSummary | null; month: string; year: string; now: Date };

export function cardFormProblem(form: CardFormState): CardFormProblem | null {
  if (form.isNew ? !form.number?.complete : !!form.number && !form.number.complete) return "number";
  if (!!form.month !== !!form.year) return "expiry";
  if (form.isNew && form.month && cardExpiry({ expMonth: Number(form.month), expYear: Number(form.year) }, form.now).expired) return "expiry";
  return null;
}

export function expiryYears(now: Date, kept?: number): number[] {
  const first = now.getFullYear();
  const years = Array.from({ length: 16 }, (_, i) => first + i);
  return kept && !years.includes(kept) ? [kept, ...years] : years;
}

const LONGEST_CARD_NUMBER = 19;

export const cardDigits = (text: string) => text.replace(/\D/g, "").slice(0, LONGEST_CARD_NUMBER);

const leading = (digits: string, width: number) => (digits.length >= width ? Number(digits.slice(0, width)) : NaN);
const startsIn = (digits: string, from: number, to: number, width: number) => {
  const head = leading(digits, width);
  return head >= from && head <= to;
};

function cardNetworkOf(digits: string): CardNetwork {
  if (startsIn(digits, 34, 34, 2) || startsIn(digits, 37, 37, 2)) return "amex";
  if (digits.startsWith("4")) return "visa";
  if (startsIn(digits, 51, 55, 2) || startsIn(digits, 2221, 2720, 4)) return "mastercard";
  if (digits.startsWith("6011") || startsIn(digits, 644, 649, 3) || digits.startsWith("65")) return "discover";
  if (startsIn(digits, 3528, 3589, 4)) return "jcb";
  if (startsIn(digits, 300, 305, 3) || digits.startsWith("36") || digits.startsWith("38") || digits.startsWith("39")) return "diners";
  if (digits.startsWith("62")) return "unionpay";
  return "card";
}

const LENGTHS: Record<CardNetwork, readonly [number, number]> = {
  amex: [15, 15],
  visa: [13, 19],
  mastercard: [16, 16],
  diners: [14, 19],
  discover: [16, 19],
  jcb: [16, 19],
  unionpay: [16, 19],
  card: [12, 19],
};

function passesLuhn(digits: string) {
  if (!digits) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const value = Number(digits[digits.length - 1 - i]);
    const doubled = i % 2 === 1 ? value * 2 : value;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

export function cardNumberSummary(text: string): CardNumberSummary {
  const digits = cardDigits(text);
  const network = cardNetworkOf(digits);
  const [shortest, longest] = LENGTHS[network];
  const luhn = passesLuhn(digits);
  return { digits: digits.length, network, complete: luhn && digits.length >= shortest && digits.length <= longest, luhn };
}

export function formatCardNumber(text: string) {
  const digits = cardDigits(text);
  const network = cardNetworkOf(digits);
  const groups = network === "amex" ? [4, 6, 5] : network === "diners" && digits.length === 14 ? [4, 6, 4] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  if (at < digits.length) parts.push(digits.slice(at));
  return parts.join(" ");
}
