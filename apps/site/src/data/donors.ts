export const DONOR_TIERS = ["patron", "backer", "friend"] as const;
export type DonorTier = (typeof DONOR_TIERS)[number];

export interface Donor {
  readonly name: string;
  readonly tier: DonorTier;
}

export const SPONSORS_PATH = "/api/sponsors";
export const DONOR_NAME_MAX = 40;
export const DONORS_MAX = 200;

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

const isTier = (tier: unknown): tier is DonorTier => DONOR_TIERS.includes(tier as DonorTier);

export function donorsFrom(body: unknown): Donor[] | null {
  const list = body !== null && typeof body === "object" ? (body as { sponsors?: unknown }).sponsors : undefined;
  if (!Array.isArray(list)) return null;
  const donors: Donor[] = [];
  for (const entry of list.slice(0, DONORS_MAX)) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, tier } = entry as { name?: unknown; tier?: unknown };
    if (typeof name !== "string" || !isTier(tier)) continue;
    const clean = name.trim();
    if (!clean || Array.from(clean).length > DONOR_NAME_MAX || HIDDEN_CHARS.test(clean)) continue;
    donors.push({ name: clean, tier });
  }
  return donors;
}
