import { useTheme } from "../ui/theme";
import { font, tracking } from "../ui/tokens";

const DARK = {
  tileStroke: "rgba(255,255,255,0.08)",
  well: "rgba(255,255,255,0.06)",
};

type SiteTokens = typeof DARK;

const LIGHT: SiteTokens = {
  tileStroke: "rgba(0,0,0,0.06)",
  well: "rgba(0,0,0,0.04)",
};

export function useSiteTokens(): SiteTokens {
  return useTheme().dark ? DARK : LIGHT;
}

export const CARD_BADGES = {
  visa: { label: "VISA", fill: "#1A1F71" },
  mastercard: { label: "", fill: "#1C1C1E" },
  amex: { label: "AMEX", fill: "#2E77BC" },
  discover: { label: "DISC", fill: "#FF6000" },
  diners: { label: "DC", fill: "#0079BE" },
  jcb: { label: "JCB", fill: "#0B7A3E" },
  unionpay: { label: "UP", fill: "#D7282F" },
  card: { label: "", fill: "#8E8E93" },
} as const;

export const MASTERCARD_RINGS = { left: "#EB001B", right: "#F79E1B" } as const;

export const cardBadgeType = { get long() { return font.badge; }, get short() { return font.badge; }, weight: "800", letterSpacing: tracking.caps } as const;

export const noticeType = () => font.small;

export const selectionBar = { showDelay: 150 } as const;
