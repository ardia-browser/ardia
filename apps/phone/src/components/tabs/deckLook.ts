import { capsule, controlSize, deckChromeLayout } from "../ui";

export const deckLook = {
  switcherHeight: deckChromeLayout.headerCircle,
  switcherCorner: capsule(deckChromeLayout.headerCircle),
  switcherLead: 14,
  switcherTrail: 16,
  fieldCorner: capsule(deckChromeLayout.barCircle),
  clearTrail: deckChromeLayout.searchTrailFilled + deckChromeLayout.clearHit / 2 - controlSize.hitTarget / 2,
  darkDepth: ["rgba(0,0,0,0.5)", "rgba(0,0,0,0.3)", "rgba(0,0,0,0.42)"],
} as const;
