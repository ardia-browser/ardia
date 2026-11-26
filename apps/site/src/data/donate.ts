export const DONATE_FREQUENCIES = [
  { key: "once", label: "One-time" },
  { key: "monthly", label: "Monthly" },
] as const;
export type DonateFrequency = (typeof DONATE_FREQUENCIES)[number]["key"];

export const DONATE_AMOUNTS = ["5", "10", "50", "67", "500", "1000", "custom"] as const;
export type DonateAmount = (typeof DONATE_AMOUNTS)[number];

export const DONATE_LINKS: Record<DonateFrequency, Partial<Record<DonateAmount, string>>> = {
  once: {
    "5": "https://donate.stripe.com/6oU6oI7488vG49Y4vd48002",
    "10": "https://donate.stripe.com/8x214o9cg4fqfSG1j14800b",
    "50": "https://donate.stripe.com/6oU6oIagk4fqdKyf9R48003",
    "67": "https://donate.stripe.com/5kQ4gAgEI13e6i60eX4800c",
    "500": "https://donate.stripe.com/3cI3cw88c13efSGd1J48004",
    "1000": "https://donate.stripe.com/3cIeVe9cgh2c7maaTB48005",
    custom: "https://donate.stripe.com/8x2dRafAEh2cfSG5zh48001",
  },
  monthly: {
    "5": "https://buy.stripe.com/bJe00k1JO6nygWKaTB48006",
    "10": "https://buy.stripe.com/eVq8wQ0FKfY87ma8Lt4800d",
    "50": "https://buy.stripe.com/aFa5kE4W0aDOeOCe5N48007",
    "67": "https://buy.stripe.com/fZubJ29cgaDOcGu7Hp4800e",
    "500": "https://buy.stripe.com/9B67sMewAeU4fSGgdV48008",
    "1000": "https://buy.stripe.com/cNiaEY2NSdQ08qe6Dl48009",
  },
};

export const DONATE_FLOOR = {
  flag: "donate-floor",
  variants: { five: "5", ten: "10" },
} as const satisfies { flag: string; variants: Record<string, DonateAmount> };
export type DonateFloorVariant = keyof typeof DONATE_FLOOR.variants;
export const donateFloorOf = (amount: DonateAmount) =>
  (Object.keys(DONATE_FLOOR.variants) as DonateFloorVariant[]).find((variant) => DONATE_FLOOR.variants[variant] === amount);
export const isDonateFloorVariant = (value: unknown): value is DonateFloorVariant =>
  typeof value === "string" && Object.hasOwn(DONATE_FLOOR.variants, value);

export const donateLabel = (amount: DonateAmount) =>
  amount === "custom" ? "Custom" : `$${Number(amount).toLocaleString("en-US")}`;


export const MONTHLY_CUSTOM = { path: "/api/donate/monthly", min: 1, max: 10_000 } as const;

export const DONATE_POP_PICKER = "donate-pop-picker";
