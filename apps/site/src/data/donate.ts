export const DONATE_FREQUENCIES = [
  { key: "once", label: "One-time" },
  { key: "monthly", label: "Monthly" },
] as const;
export type DonateFrequency = (typeof DONATE_FREQUENCIES)[number]["key"];

export const DONATE_AMOUNTS = ["5", "50", "500", "1000", "custom"] as const;
export type DonateAmount = (typeof DONATE_AMOUNTS)[number];

export const DONATE_LINKS: Record<DonateFrequency, Partial<Record<DonateAmount, string>>> = {
  once: {
    "5": "https://donate.stripe.com/6oU6oI7488vG49Y4vd48002",
    "50": "https://donate.stripe.com/6oU6oIagk4fqdKyf9R48003",
    "500": "https://donate.stripe.com/3cI3cw88c13efSGd1J48004",
    "1000": "https://donate.stripe.com/3cIeVe9cgh2c7maaTB48005",
    custom: "https://donate.stripe.com/8x2dRafAEh2cfSG5zh48001",
  },
  monthly: {
    "5": "https://buy.stripe.com/bJe00k1JO6nygWKaTB48006",
    "50": "https://buy.stripe.com/aFa5kE4W0aDOeOCe5N48007",
    "500": "https://buy.stripe.com/9B67sMewAeU4fSGgdV48008",
    "1000": "https://buy.stripe.com/cNiaEY2NSdQ08qe6Dl48009",
  },
};

export const donateLabel = (amount: DonateAmount) =>
  amount === "custom" ? "Custom" : `$${Number(amount).toLocaleString("en-US")}`;


export const MONTHLY_CUSTOM = { path: "/api/donate/monthly", min: 1, max: 10_000 } as const;
